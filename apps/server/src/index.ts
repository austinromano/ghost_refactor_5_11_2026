import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import { ZodError } from 'zod';
import auth from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import trackRoutes from './routes/tracks.js';
import versionRoutes from './routes/versions.js';
import commentRoutes from './routes/comments.js';
import fileRoutes from './routes/files.js';
import sessionRoutes from './routes/sessions.js';
import invitationRoutes from './routes/invitations.js';
import userRoutes from './routes/users.js';
import likeRoutes from './routes/likes.js';
import samplePackRoutes from './routes/samplepacks.js';
import sampleLibraryRoutes from './routes/sampleLibrary.js';
import notificationRoutes from './routes/notifications.js';
import socialRoutes from './routes/social.js';
import dmRoutes from './routes/directMessages.js';
import bookingsRoutes from './routes/bookings.js';
import communityRoutes from './routes/communities.js';
import publicShareRoutes from './routes/publicShare.js';
import { setupWebSocket } from './ws/index.js';
import { initDatabase } from './db/index.js';
import { authMiddleware } from './middleware/auth.js';

// Initialize database tables (async now with Turso)
await initDatabase();

const app = new Hono();

// Global middleware
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173,http://localhost:1420')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Gzip responses so JSON payloads (project detail with inline peaks, feeds,
// member lists) don't blow egress. Binary audio streams already have the
// `Accept-Ranges`/content-type set and are negligible to compress, so this
// primarily benefits the large JSON endpoints.
app.use('*', compress());

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (allowedOrigins.includes('*')) return origin;
    return allowedOrigins.includes(origin) ? origin : null;
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Debug endpoint: logs to stdout so it works on any platform (Railway, Linux, Windows).
app.post('/api/v1/debug', async (c) => {
  const body = await c.req.text();
  console.log('[client-debug]', new Date().toISOString(), body);
  return c.json({ ok: true });
});

// Fix double /api/v1 prefix from cached frontend builds
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/v1/api/v1/')) {
    const fixed = url.pathname.replace('/api/v1/api/v1/', '/api/v1/');
    return c.redirect(fixed, 301);
  }
  await next();
});

// API routes
app.route('/api/v1/auth', auth);
app.route('/api/v1/projects', projectRoutes);
app.route('/api/v1/projects/:id/tracks', trackRoutes);
app.route('/api/v1/projects/:id/versions', versionRoutes);
app.route('/api/v1/projects/:id/comments', commentRoutes);
app.route('/api/v1/projects/:id/files', fileRoutes);
app.route('/api/v1/projects/:id/sessions', sessionRoutes);
app.route('/api/v1/invitations', invitationRoutes);
app.route('/api/v1/users', userRoutes);
app.route('/api/v1/tracks', likeRoutes);
app.route('/api/v1/sample-packs', samplePackRoutes);
app.route('/api/v1/sample-library', sampleLibraryRoutes);
app.route('/api/v1/notifications', notificationRoutes);
app.route('/api/v1/social', socialRoutes);
app.route('/api/v1/dm', dmRoutes);
app.route('/api/v1/bookings', bookingsRoutes);
app.route('/api/v1/communities', communityRoutes);
// Public read-only project share — no auth, gated by share token
app.route('/api/v1/public/projects', publicShareRoutes);

// Serve the desktop app build
import { serveStatic } from '@hono/node-server/serve-static';

// Cache policy: hashed assets are immutable (safe to cache for a year);
// index.html must not be cached so new deploys are picked up immediately.
app.use('*', async (c, next) => {
  await next();
  const path = new URL(c.req.url).pathname;
  // Service worker must never be long-cached or new versions never ship.
  if (path === '/sw.js') {
    c.res.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    c.res.headers.set('Service-Worker-Allowed', '/');
  } else if (path.endsWith('.html') || path === '/' || path === '/app') {
    c.res.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    c.res.headers.set('Pragma', 'no-cache');
    c.res.headers.set('Expires', '0');
  } else if (path.startsWith('/assets/')) {
    // /assets/ filenames are content-hashed by Vite, so caching them
    // forever is safe — the URL itself changes on every build.
    c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (path.match(/\.(js|css|woff2?|png|jpg|jpeg|gif|svg|webp|ico)$/i)) {
    // Root-level assets (un-hashed: beat-battle-hero.png, worklets,
    // favicons, etc.) get a SHORT cache so a replacement actually
    // propagates. Previously they shared the 1-year immutable cache
    // with /assets/, and a stale 404 from a missing route would stick
    // in browser cache forever even after the server started serving
    // the file correctly.
    c.res.headers.set('Cache-Control', 'public, max-age=300');
  }
});

// Try local public folder first (Railway), then ../desktop/dist (local dev)
app.use('/app/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace('/app', '') }));
app.use('/app/*', serveStatic({ root: '../desktop/dist', rewriteRequestPath: (p) => p.replace('/app', '') }));
app.get('/app', serveStatic({ root: './public', path: '/index.html' }));
app.get('/app', serveStatic({ root: '../desktop/dist', path: '/index.html' }));

// Serve at root for VST3 plugin and direct access
app.use('/assets/*', serveStatic({ root: './public' }));
app.use('/assets/*', serveStatic({ root: '../desktop/dist' }));
app.get('/sw.js', serveStatic({ root: './public', path: '/sw.js' }));
app.get('/sw.js', serveStatic({ root: '../desktop/dist', path: '/sw.js' }));
// Specific root-level static files. The base serveStatic above only
// covers /assets and /sw.js, so any file dropped into ./public for
// direct root access (PNG hero backgrounds, worklets, favicons, etc.)
// needs an explicit route. Hono's route matcher doesn't support
// glob brace expansion, so we list the files we actually serve.
app.get('/beat-battle-hero.png', serveStatic({ root: './public', path: '/beat-battle-hero.png' }));
app.get('/beat-battle-hero.png', serveStatic({ root: '../desktop/dist', path: '/beat-battle-hero.png' }));
app.get('/ghost-watermark.png', serveStatic({ root: './public', path: '/ghost-watermark.png' }));
app.get('/ghost-watermark.png', serveStatic({ root: '../desktop/dist', path: '/ghost-watermark.png' }));
app.get('/master-limiter-worklet.js', serveStatic({ root: './public', path: '/master-limiter-worklet.js' }));
app.get('/master-limiter-worklet.js', serveStatic({ root: '../desktop/dist', path: '/master-limiter-worklet.js' }));
app.get('/track-compressor-worklet.js', serveStatic({ root: './public', path: '/track-compressor-worklet.js' }));
app.get('/track-compressor-worklet.js', serveStatic({ root: '../desktop/dist', path: '/track-compressor-worklet.js' }));
app.get('/warped-playback-worklet.js', serveStatic({ root: './public', path: '/warped-playback-worklet.js' }));
app.get('/warped-playback-worklet.js', serveStatic({ root: '../desktop/dist', path: '/warped-playback-worklet.js' }));
app.get('/', serveStatic({ root: './public', path: '/index.html' }));
app.get('/', serveStatic({ root: '../desktop/dist', path: '/index.html' }));

// SPA fallback for the public share route — serve index.html so client-side
// routing in App.tsx can pick up `/p/<token>` and render the viewer.
app.get('/p/*', serveStatic({ root: './public', path: '/index.html' }));
app.get('/p/*', serveStatic({ root: '../desktop/dist', path: '/index.html' }));

// One-time DB reset (requires authentication)
app.delete('/api/v1/admin/reset-all', authMiddleware, async (c) => {
  const { client } = await import('./db/index.js');
  try {
    await client.executeMultiple(`
      DELETE FROM social_post_reactions;
      DELETE FROM social_post_comments;
      DELETE FROM social_post_likes;
      DELETE FROM social_posts;
      DELETE FROM chat_messages;
      DELETE FROM notifications;
      DELETE FROM invitations;
      DELETE FROM tracks;
      DELETE FROM versions;
      DELETE FROM project_members;
      DELETE FROM projects;
      DELETE FROM follows;
      DELETE FROM auth_sessions;
      DELETE FROM users;
    `);
    return c.json({ success: true, message: 'All data deleted' });
  } catch (err) {
    console.error('[admin/reset-all] failed:', err);
    return c.json({ error: 'Reset failed' }, 500);
  }
});

// Storage usage for authenticated user — sums every byte the user owns
// across project files AND the sample library.
app.get('/api/v1/storage', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const { db: database } = await import('./db/index.js');
  const { files, sampleLibraryFiles } = await import('./db/schema.js');
  const { eq, sql } = await import('drizzle-orm');
  const [projectResult] = await database
    .select({ total: sql<number>`coalesce(sum(file_size), 0)` })
    .from(files)
    .where(eq(files.uploadedBy, user.id)).all();
  const [libraryResult] = await database
    .select({ total: sql<number>`coalesce(sum(file_size), 0)` })
    .from(sampleLibraryFiles)
    .where(eq(sampleLibraryFiles.userId, user.id)).all();
  const projectBytes = projectResult?.total || 0;
  const libraryBytes = libraryResult?.total || 0;
  const usedBytes = projectBytes + libraryBytes;
  const limitBytes = 2 * 1024 * 1024 * 1024; // 2 GB free tier
  return c.json({
    success: true,
    data: { usedBytes, limitBytes, projectBytes, libraryBytes },
  });
});

// Public stats endpoint — no auth required
app.get('/api/v1/stats', async (c) => {
  const { db: database } = await import('./db/index.js');
  const { users, projects, tracks } = await import('./db/schema.js');
  const { sql } = await import('drizzle-orm');
  const [userCount] = await database.select({ count: sql<number>`count(*)` }).from(users).all();
  const [projectCount] = await database.select({ count: sql<number>`count(*)` }).from(projects).all();
  const [trackCount] = await database.select({ count: sql<number>`count(*)` }).from(tracks).all();
  return c.json({
    users: userCount.count,
    projects: projectCount.count,
    tracks: trackCount.count,
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ success: false, error: err.message }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({
      success: false,
      error: 'Validation error',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    }, 400);
  }
  console.error('[Server Error]', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

// Start server
const port = parseInt(process.env.PORT || '3000', 10);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\n  Ghost Session API running on http://localhost:${info.port}`);
  console.log(`  WebSocket ready on ws://localhost:${info.port}\n`);
});

// Attach Socket.IO to the HTTP server
setupWebSocket(server as any);
