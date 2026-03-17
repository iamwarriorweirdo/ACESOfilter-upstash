import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Import Vercel handlers
import appHandler from './api/app.ts';
import chatHandler from './api/chat.ts';
import agentChatHandler from './api/agent_chat.ts';
import uploadCloudinaryHandler from './api/upload-cloudinary.ts';
import workflowHandler from './api/workflow.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = process.env.PORT || 3000;

  // Middleware to parse JSON bodies
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Helper to adapt Vercel handler to Express
  const adaptVercel = (handler: any) => async (req: any, res: any) => {
    try {
      // Vercel handlers expect req.query to be an object
      // Express already provides this.
      await handler(req, res);
    } catch (error: any) {
      console.error('API Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Internal Server Error' });
      }
    }
  };

  // Mount API routes
  app.all('/api/app', adaptVercel(appHandler));
  app.all('/api/chat', adaptVercel(chatHandler));
  app.all('/api/agent_chat', adaptVercel(agentChatHandler));
  app.all('/api/upload-cloudinary', adaptVercel(uploadCloudinaryHandler));
  
  // Workflow handler (Upstash Workflow uses its own Express adapter in the file)
  // But the file exports the result of serve(), which is an Express handler
  app.all('/api/workflow', workflowHandler);

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      console.warn('Production build not found. Please run "npm run build" first.');
    }
  } else {
    // Vite middleware for development
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
