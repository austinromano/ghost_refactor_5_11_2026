import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/index.js';
import { projects, projectMembers, tracks, users, invitations, chatMessages, follows, files } from '../db/schema.js';
import { eq, or, and, desc, like, inArray } from 'drizzle-orm';
import { authMiddleware, type AuthUser } from '../middleware/auth.js';
import { createAutoSnapshot } from '../lib/autoSnapshot.js';
import { postActivityComment } from '../lib/activityComment.js';
import { assertMember, assertEditor } from '../lib/membership.js';
import { emitProjectUpdated, emitArrangementUpdated } from '../ws/index.js';

const projectRoutes = new Hono();
projectRoutes.use('*', authMiddleware);

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  tempo: z.number().min(0).max(300).optional().default(0),
  key: z.string().max(10).optional().default(''),
  genre: z.string().max(50).optional().default(''),
  projectType: z.string().optional().default('project'),
  timeSignature: z.string().max(10).optional().default('4/4'),
  battleId: z.string().max(100).optional().nullable(),
  battleEndsAt: z.string().max(40).optional().nullable(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  tempo: z.number().min(30).max(300).optional(),
  key: z.string().max(10).optional(),
  genre: z.string().max(50).optional(),
  timeSignature: z.string().max(10).optional(),
});

const inviteMemberSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
  role: z.enum(['editor', 'viewer']).optional().default('editor'),
}).refine(d => d.email || d.name, { message: 'Provide email or name' });

projectRoutes.get('/', async (c) => {
  const user = c.get('user') as AuthUser;

  const memberOf = await db.select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id))
    .all();

  if (memberOf.length === 0) return c.json({ success: true, data: [] });

  const result = await db.select().from(projects)
    .where(or(...memberOf.map((m) => eq(projects.id, m.projectId))))
    .orderBy(desc(projects.updatedAt))
    .all();

  return c.json({ success: true, data: result });
});

projectRoutes.post('/', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = createProjectSchema.parse(await c.req.json());
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db.insert(projects).values({
    id, ...body, ownerId: user.id, createdAt: now, updatedAt: now,
  }).run();

  await db.insert(projectMembers).values({
    projectId: id, userId: user.id, role: 'owner', joinedAt: now,
  }).run();

  const [project] = await db.select().from(projects).where(eq(projects.id, id)).all();
  return c.json({ success: true, data: project }, 201);
});

projectRoutes.get('/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');

  await assertMember(projectId, user.id);

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1).all();
  if (!project) throw new HTTPException(404, { message: 'Project not found' });

  const members = await db.select({
    userId: projectMembers.userId,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    role: projectMembers.role,
    joinedAt: projectMembers.joinedAt,
  }).from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, projectId))
    .all();

  const projectTracks = await db.select().from(tracks)
    .where(eq(tracks.projectId, projectId))
    .orderBy(tracks.position)
    .all();

  // Fetch peaks + BPM analysis for all file-backed tracks in one query and
  // attach inline, so the client can render waveforms and time-stretch with
  // no extra round trips.
  const fileIds = Array.from(new Set(projectTracks.map((t) => t.fileId).filter((id): id is string => !!id)));
  const fileMeta = new Map<string, {
    peaks: any; detectedBpm: number | null; bpmConfidence: number | null;
    firstBeatOffset: number | null; beats: number[] | null;
    sampleCharacter: string | null; crestFactor: number | null;
  }>();
  if (fileIds.length > 0) {
    const rows = await db.select({
      id: files.id, peaks: files.peaks,
      detectedBpm: files.detectedBpm, bpmConfidence: files.bpmConfidence,
      firstBeatOffset: files.firstBeatOffset, beatsJson: files.beatsJson,
      sampleCharacter: files.sampleCharacter, crestFactor: files.crestFactor,
    }).from(files).where(inArray(files.id, fileIds)).all();
    for (const r of rows) {
      let peaks = null;
      if (r.peaks) {
        try { peaks = JSON.parse(r.peaks); } catch { /* skip corrupt cached peaks */ }
      }
      let beats: number[] | null = null;
      if (r.beatsJson) {
        try { beats = JSON.parse(r.beatsJson); } catch { /* skip corrupt beats */ }
      }
      fileMeta.set(r.id, {
        peaks,
        detectedBpm: r.detectedBpm ?? null,
        bpmConfidence: r.bpmConfidence ?? null,
        firstBeatOffset: r.firstBeatOffset ?? null,
        beats,
        sampleCharacter: r.sampleCharacter ?? null,
        crestFactor: r.crestFactor ?? null,
      });
    }
  }
  const tracksWithPeaks = projectTracks.map((t) => {
    const meta = t.fileId ? fileMeta.get(t.fileId) : undefined;
    return {
      ...t,
      peaks: meta?.peaks ?? null,
      detectedBpm: meta?.detectedBpm ?? null,
      bpmConfidence: meta?.bpmConfidence ?? null,
      firstBeatOffset: meta?.firstBeatOffset ?? null,
      beats: meta?.beats ?? null,
      sampleCharacter: meta?.sampleCharacter ?? null,
      crestFactor: meta?.crestFactor ?? null,
    };
  });

  return c.json({ success: true, data: { ...project, members, tracks: tracksWithPeaks } });
});

projectRoutes.patch('/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');
  const body = updateProjectSchema.parse(await c.req.json());

  await assertEditor(projectId, user.id);

  // Session-auto-created projects: only the host (project owner) may rename.
  // Other metadata edits remain open to all editors. Invitees could still
  // create misleading context by renaming a scheduled session, so we lock it.
  if (body.name !== undefined) {
    const { bookings } = await import('../db/schema.js');
    const [bk] = await db.select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.projectId, projectId))
      .limit(1).all();
    if (bk) {
      const [project] = await db.select({ ownerId: projects.ownerId })
        .from(projects).where(eq(projects.id, projectId)).limit(1).all();
      if (project && project.ownerId !== user.id) {
        throw new HTTPException(403, { message: 'Only the session host can rename this project' });
      }
    }
  }

  await db.update(projects).set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId)).run();

  const [updated] = await db.select().from(projects).where(eq(projects.id, projectId)).all();

  const changes = Object.keys(body).join(', ');
  await createAutoSnapshot(projectId, user.id, `Updated project: ${changes}`);
  await postActivityComment(projectId, user.id, `✏️ updated project settings: ${changes}`);

  emitProjectUpdated(projectId, 'metadata-updated');
  return c.json({ success: true, data: updated });
});

// POST /:id/share — generate (or return) a public read-only share token.
// Idempotent: re-enabling on an already-shared project returns the same
// token so existing links keep working.
projectRoutes.post('/:id/share', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');
  await assertEditor(projectId, user.id);

  const [existing] = await db.select({ shareToken: projects.shareToken })
    .from(projects).where(eq(projects.id, projectId)).limit(1).all();
  if (!existing) throw new HTTPException(404, { message: 'Project not found' });

  if (existing.shareToken) {
    return c.json({ success: true, data: { shareToken: existing.shareToken } });
  }

  // Crypto-random 32-char token. URL-safe base64 of 24 random bytes.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString('base64url');

  await db.update(projects).set({ shareToken: token, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId)).run();

  return c.json({ success: true, data: { shareToken: token } });
});

// DELETE /:id/share — revoke the public link. Existing /p/<token> URLs
// will 404 immediately after this returns.
projectRoutes.delete('/:id/share', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');
  await assertEditor(projectId, user.id);

  await db.update(projects).set({ shareToken: null, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId)).run();

  return c.json({ success: true });
});

// PUT /:id/arrangement — full arrangement blob (clip offsets, trims, volumes,
// mute/solo, pitch). Editors can write. We store as a JSON string and emit
// project-updated so every collaborator in the room refreshes their layout.
projectRoutes.put('/:id/arrangement', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');
  const body = await c.req.json();

  await assertEditor(projectId, user.id);

  if (!body || typeof body !== 'object' || !Array.isArray(body.clips)) {
    throw new HTTPException(400, { message: 'arrangement.clips must be an array' });
  }

  const serialized = JSON.stringify(body);
  try {
    await db.update(projects)
      .set({ arrangementJson: serialized, updatedAt: new Date().toISOString() })
      .where(eq(projects.id, projectId))
      .run();
  } catch (err) {
    console.error(`[arrangement.save] FAILED project=${projectId} user=${user.id}:`, err);
    throw err;
  }

  // Lightweight broadcast — carries just the new JSON. DO NOT use
  // emitProjectUpdated here; that would force every collaborator to refetch
  // the entire project detail (including inline peaks) and compounds into
  // a huge egress bill during rapid saves.
  emitArrangementUpdated(projectId, serialized);
  return c.json({ success: true });
});

projectRoutes.delete('/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1).all();
  if (!project || project.ownerId !== user.id) {
    throw new HTTPException(403, { message: 'Only the owner can delete' });
  }

  await db.delete(projects).where(eq(projects.id, projectId)).run();
  return c.json({ success: true });
});

projectRoutes.post('/:id/members', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');
  const body = inviteMemberSchema.parse(await c.req.json());

  await assertEditor(projectId, user.id);

  let invitee;
  if (body.email) {
    [invitee] = await db.select().from(users).where(eq(users.email, body.email)).limit(1).all();
  } else if (body.name) {
    [invitee] = await db.select().from(users).where(like(users.displayName, body.name)).limit(1).all();
  }
  if (!invitee) throw new HTTPException(404, { message: 'User not found' });

  // Check if already a member
  const existing = await db.select().from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, invitee.id)))
    .limit(1).all();
  if (existing.length > 0) {
    return c.json({ success: true, message: 'Already a member' });
  }

  // Create a pending invitation instead of directly adding
  const invId = crypto.randomUUID();
  try {
    await db.insert(invitations).values({
      id: invId,
      projectId,
      inviterId: user.id,
      inviteeId: invitee.id,
      role: body.role,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/UNIQUE|PRIMARY KEY/i.test(msg)) console.warn('[projects.invite] insert failed:', err);
  }

  // Auto-add as friend (both directions) so they show in presence bar
  const existingFollow = await db.select().from(follows)
    .where(and(eq(follows.followerId, user.id), eq(follows.followingId, invitee.id)))
    .limit(1).all();
  if (existingFollow.length === 0) {
    await db.insert(follows).values({ followerId: user.id, followingId: invitee.id, createdAt: new Date().toISOString() }).run();
  }
  const reverseFollow = await db.select().from(follows)
    .where(and(eq(follows.followerId, invitee.id), eq(follows.followingId, user.id)))
    .limit(1).all();
  if (reverseFollow.length === 0) {
    await db.insert(follows).values({ followerId: invitee.id, followingId: user.id, createdAt: new Date().toISOString() }).run();
  }

  await postActivityComment(projectId, user.id, `📨 invited ${invitee.displayName} to the project`);

  return c.json({ success: true, message: 'Invitation sent' });
});

// Remove a member from a project (owner only)
projectRoutes.delete('/:id/members/:userId', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');
  const targetUserId = c.req.param('userId');

  const membership = await assertMember(projectId, user.id);

  if (membership.role !== 'owner') {
    throw new HTTPException(403, { message: 'Only the project owner can remove members' });
  }

  if (targetUserId === user.id) {
    throw new HTTPException(400, { message: 'Cannot remove yourself from the project' });
  }

  const [removedUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1).all();

  await db.delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, targetUserId)))
    .run();

  await postActivityComment(projectId, user.id, `👋 removed ${removedUser?.displayName || 'a member'} from the project`);

  emitProjectUpdated(projectId, 'member-changed');
  return c.json({ success: true });
});

// Leave a project (non-owner members only)
projectRoutes.post('/:id/leave', async (c) => {
  const user = c.get('user') as AuthUser;
  const projectId = c.req.param('id');

  const membership = await assertMember(projectId, user.id);

  if (membership.role === 'owner') {
    throw new HTTPException(400, { message: 'Owner cannot leave the project. Transfer ownership or delete it.' });
  }

  await postActivityComment(projectId, user.id, `👋 left the project`);

  await db.delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)))
    .run();

  emitProjectUpdated(projectId, 'member-changed');
  return c.json({ success: true });
});

// Get chat history for a project
projectRoutes.get('/:id/chat', async (c) => {
  const projectId = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '100', 10);

  const messages = (await db.select({
    id: chatMessages.id,
    userId: chatMessages.userId,
    displayName: chatMessages.displayName,
    colour: chatMessages.colour,
    text: chatMessages.text,
    createdAt: chatMessages.createdAt,
    avatarUrl: users.avatarUrl,
  })
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.userId))
    .where(eq(chatMessages.projectId, projectId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
    .all())
    .reverse() // oldest first
    .map((m) => ({
      id: m.id,
      userId: m.userId,
      displayName: m.displayName,
      colour: m.colour,
      text: m.text,
      timestamp: new Date(m.createdAt).getTime(),
      avatarUrl: m.avatarUrl,
    }));

  return c.json({ success: true, data: messages });
});

export default projectRoutes;
