import { neon } from '@neondatabase/serverless';
import { v2 as cloudinary } from 'cloudinary';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Client } from '@upstash/qstash';

const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
const WORKFLOW_URL = process.env.UPSTASH_WORKFLOW_URL || `${process.env.APP_URL}/api/workflow`;

async function triggerWorkflow(event: string, data: any) {
    if (!process.env.QSTASH_TOKEN) {
        console.warn("QSTASH_TOKEN not found. Skipping workflow trigger.");
        return;
    }
    try {
        await qstash.publishJSON({
            url: WORKFLOW_URL,
            body: { event, data },
        });
    } catch (e) {
        console.error("Error triggering workflow:", e);
    }
}

const rawConnectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;

async function getSql() {
    if (!rawConnectionString) {
        throw new Error("Server chưa được cấu hình Database. Vui lòng kiểm tra DATABASE_URL hoặc POSTGRES_URL.");
    }
    const connectionString = rawConnectionString.replace('postgresql://', 'postgres://').trim();
    return neon(connectionString);
}

function getCloudinaryConfig() {
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
        return {
            cloudName: process.env.CLOUDINARY_CLOUD_NAME,
            apiKey: process.env.CLOUDINARY_API_KEY,
            apiSecret: process.env.CLOUDINARY_API_SECRET
        };
    }
    const url = process.env.CLOUDINARY_URL;
    if (url && url.startsWith('cloudinary://')) {
        try {
            const [creds, cloud] = url.replace('cloudinary://', '').split('@');
            const [key, secret] = creds.split(':');
            return { cloudName: cloud, apiKey: key, apiSecret: secret };
        } catch (e) { 
            console.error("Error parsing CLOUDINARY_URL", e);
            return {}; 
        }
    }
    return {};
}

// --- HANDLERS ---

async function handleBackup(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    try {
        const users = await sql`SELECT * FROM users`.catch(() => []);
        const documents = await sql`SELECT * FROM documents`.catch(() => []);
        const folders = await sql`SELECT * FROM app_folders`.catch(() => []);
        const settings = await sql`SELECT * FROM system_settings`.catch(() => []);
        const chats = await sql`SELECT * FROM chat_history ORDER BY created_at DESC LIMIT 1000`.catch(() => []);

        const backupData = {
            timestamp: Date.now(),
            users,
            documents,
            folders,
            settings,
            chats,
            version: "1.1",
            exportedAt: new Date().toISOString()
        };

        const filename = `full_system_backup_${new Date().toISOString().split('T')[0]}.json`;
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.status(200).send(JSON.stringify(backupData, null, 2));
    } catch (e: any) {
        return res.status(500).json({ error: `Backup failed: ${e.message}` });
    }
}

async function handleUsers(req: VercelRequest, res: VercelResponse) {
    if (req.method?.toUpperCase() !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* ignore */ } }
    const { action, username, password, role, createdBy } = body;

    if (action === 'login') {
        const sysAdminUser = (process.env.ADMIN_USER || process.env.ADMIN_USERNAME || '').trim();
        const sysAdminPass = (process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || '').trim();
        const inputUser = (username || '').trim();
        const inputPass = (password || '').trim();

        if (sysAdminUser && inputUser.toLowerCase() === sysAdminUser.toLowerCase()) {
            if (inputPass === sysAdminPass) {
                return res.status(200).json({ success: true, user: { username: sysAdminUser, role: 'superadmin' } });
            }
        }
        
        const sql = await getSql();
        try {
            const results = await sql`SELECT * FROM users WHERE username = ${username} AND password = ${password}`;
            if (results.length > 0) return res.status(200).json({ success: true, user: results[0] });
        } catch (e) {
            await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
            const results = await sql`SELECT * FROM users WHERE username = ${username} AND password = ${password}`;
            if (results.length > 0) return res.status(200).json({ success: true, user: results[0] });
        }
        return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu." });
    }
    
    if (action === 'create') {
        const sql = await getSql();
        await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
        const roleVal = (role === 'superadmin' || role === 'it' || role === 'hr' || role === 'employee') ? role : 'employee';
        await sql`INSERT INTO users (username, password, role, created_at, created_by) VALUES (${username}, ${password}, ${roleVal}, ${Date.now()}, ${createdBy || 'system'}) ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role`;
        return res.status(200).json({ success: true });
    }

    if (action === 'list') {
        const sql = await getSql();
        await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
        const rows = await sql`SELECT username, role, created_at, created_by FROM users ORDER BY username`;
        return res.status(200).json({ users: rows });
    }
    if (action === 'delete') {
         const sql = await getSql();
         await sql`DELETE FROM users WHERE username = ${username}`;
         return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: "Invalid action" });
}

async function handleFiles(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    const method = req.method?.toUpperCase();
    
    // Ensure DB Schema is up to date with Security fields
    try {
        await sql`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT, type TEXT, content TEXT, url TEXT, size BIGINT, upload_date BIGINT, extracted_content TEXT, folder_id TEXT, uploaded_by TEXT, status TEXT)`;
        // Add allowed_roles if not exists
        await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS allowed_roles TEXT`; 
    } catch (e) { /* ignore */ }

    if (method === 'GET') {
        const { id } = req.query;
        if (id) {
            const rows = await sql`SELECT id, name, extracted_content, allowed_roles FROM documents WHERE id = ${id}`;
            if (rows.length === 0) return res.status(404).json({ error: "File not found" });
            const doc = rows[0];
            return res.status(200).json({
                ...doc,
                allowedRoles: doc.allowed_roles ? JSON.parse(doc.allowed_roles) : ['employee', 'hr', 'it', 'superadmin']
            });
        }
        const docs = await sql`SELECT id, name, type, content, url, size, upload_date, folder_id, uploaded_by, status, allowed_roles FROM documents ORDER BY upload_date DESC`.catch(() => []);
        const mappedDocs = docs.map((d: any) => ({
            id: d.id, name: d.name, type: d.type, content: d.content || d.url, url: d.url || d.content,
            size: Number(d.size), uploadDate: Number(d.upload_date), status: d.status || 'pending',
            folderId: d.folder_id || null, uploadedBy: d.uploaded_by || 'system',
            allowedRoles: d.allowed_roles ? JSON.parse(d.allowed_roles) : ['employee', 'hr', 'it', 'superadmin']
        }));
        return res.status(200).json(mappedDocs);
    }
    
    if (method === 'POST') {
        let doc = req.body || {};
        if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch (e) { /* ignore */ } }
        
        // Handle metadata update (e.g. updating allowed roles or content)
        if (doc.extractedContent && !doc.name) {
            await sql`UPDATE documents SET extracted_content = ${doc.extractedContent} WHERE id = ${doc.id}`;
            return res.status(200).json({ success: true });
        }
        // Handle Allowed Roles Update specifically
        if (doc.allowedRoles && doc.id && !doc.name) {
             const rolesJson = JSON.stringify(doc.allowedRoles);
             await sql`UPDATE documents SET allowed_roles = ${rolesJson} WHERE id = ${doc.id}`;
             
             // Trigger re-indexing to update vectors with new RBAC
             await triggerWorkflow("app/process.file", { url: null, fileName: null, docId: doc.id, reindexOnly: true });

             return res.status(200).json({ success: true });
        }

        // Handle New/Update File
        const rolesJson = JSON.stringify(doc.allowedRoles || ['employee', 'hr', 'it', 'superadmin']);
        
        await sql`INSERT INTO documents (id, name, type, content, url, size, upload_date, uploaded_by, folder_id, extracted_content, status, allowed_roles) 
                  VALUES (${doc.id}, ${doc.name}, ${doc.type}, ${doc.content}, ${doc.content}, ${doc.size}, ${doc.uploadDate}, ${doc.uploadedBy}, ${doc.folderId || null}, ${doc.extractedContent || ''}, ${doc.status || 'pending'}, ${rolesJson}) 
                  ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, content = EXCLUDED.content, extracted_content = EXCLUDED.extracted_content, folder_id = EXCLUDED.folder_id, status = EXCLUDED.status, allowed_roles = EXCLUDED.allowed_roles`;
        
        return res.status(200).json({ success: true });
    }

    if (method === 'DELETE') {
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* ignore */ } }
        const docId = body.id;
        const rows = await sql`SELECT id, url, content FROM documents WHERE id = ${docId}`;
        
        if (rows.length > 0) {
            const row = rows[0];
            const fileUrl = row.url || row.content;
            await triggerWorkflow("app/delete.file", { docId: row.id, url: fileUrl });
            // ... (Cloudinary/Supabase deletion logic remains same)
        }
        await sql`DELETE FROM documents WHERE id = ${docId}`;
        return res.status(200).json({ success: true });
    }
    return res.status(405).end();
}

async function handleFolders(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* ignore */ } }
    const { action } = body;
    if (action === 'list') {
        const folders = await sql`SELECT * FROM app_folders ORDER BY name ASC`.catch(async () => {
            await sql`CREATE TABLE IF NOT EXISTS app_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at BIGINT)`;
            return [];
        });
        return res.status(200).json({ folders: folders.map((f: any) => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: Number(f.created_at) })) });
    }
    if (action === 'create') {
        await sql`INSERT INTO app_folders (id, name, parent_id, created_at) VALUES (${body.id}, ${body.name}, ${body.parentId || null}, ${Date.now()})`.catch(async () => {
            await sql`CREATE TABLE IF NOT EXISTS app_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at BIGINT)`;
            await sql`INSERT INTO app_folders (id, name, parent_id, created_at) VALUES (${body.id}, ${body.name}, ${body.parentId || null}, ${Date.now()})`;
        });
        return res.status(200).json({ success: true });
    }
    if (action === 'update') {
        await sql`UPDATE app_folders SET name = ${body.name} WHERE id = ${body.id}`;
        return res.status(200).json({ success: true });
    }
    if (action === 'delete') {
        await sql`DELETE FROM app_folders WHERE id = ${body.id}`;
        // Note: Should recursively update documents to null folder, but keeping simple for now
        return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: "Action not supported" });
}

async function handleChatSessions(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    await sql`CREATE TABLE IF NOT EXISTS chat_history (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, messages TEXT, created_at BIGINT)`;
    
    if (req.method === 'GET') {
        const { username } = req.query;
        if (!username) return res.status(200).json({ sessions: [] });
        const rows = await sql`SELECT * FROM chat_history WHERE user_id = ${username} ORDER BY created_at DESC LIMIT 50`;
        const sessions = rows.map((r: any) => ({
            id: r.id,
            title: r.title,
            messages: JSON.parse(r.messages || '[]'),
            updatedAt: Number(r.created_at)
        }));
        return res.status(200).json({ sessions });
    }
    
    if (req.method === 'DELETE') {
        const { id } = req.body;
        await sql`DELETE FROM chat_history WHERE id = ${id}`;
        return res.status(200).json({ success: true });
    }
    return res.status(405).end();
}

async function handleUploadSupabase(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: "Supabase chưa được cấu hình." });
    }

    try {
        const supabase = createClient(supabaseUrl, supabaseKey);
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { /* ignore */ } }
        
        const filename = body.filename || `file_${Date.now()}`;
        const cleanName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const path = `${Date.now()}_${cleanName}`;

        const { data, error } = await supabase.storage
            .from('documents')
            .createSignedUploadUrl(path);

        if (error) {
             return res.status(500).json({ error: `Supabase Error: ${error.message}` });
        }

        const { data: publicData } = supabase.storage
            .from('documents')
            .getPublicUrl(path);

        return res.status(200).json({
            uploadUrl: data?.signedUrl,
            publicUrl: publicData.publicUrl
        });
    } catch (e: any) {
        return res.status(500).json({ error: e.message });
    }
}

async function handleProxy(req: VercelRequest, res: VercelResponse) {
    const { url, contentType: forcedType } = req.query; 
    if (Array.isArray(url)) url = url[0]; 
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const upstream = await (fetch as any)(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', (forcedType as string) || upstream.headers.get('content-type') || 'application/octet-stream');
    return res.status(200).send(buffer);
}

// --- EXPORT ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const { handler: h } = req.query;
    const action = Array.isArray(h) ? h[0].toLowerCase() : String(h || "").toLowerCase();

    try {
        if (action === 'backup') return await handleBackup(req, res);
        if (action === 'proxy') return await handleProxy(req, res);
        if (action === 'users') return await handleUsers(req, res);
        if (action === 'files') return await handleFiles(req, res);
        if (action === 'folders') return await handleFolders(req, res);
        if (action === 'chats') return await handleChatSessions(req, res);
        if (action === 'upload-supabase') return await handleUploadSupabase(req, res);
        if (action === 'sync') {
            await triggerWorkflow("app/sync.database", { timestamp: Date.now() });
            return res.status(200).json({ success: true });
        }
        if (action === 'config') {
            const sql = await getSql();
            if (req.method === 'POST') {
                await sql`INSERT INTO system_settings (id, data) VALUES ('global', ${JSON.stringify(req.body)}) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
                return res.status(200).json({ success: true });
            }
            const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`.catch(() => []);
            return res.status(200).json(rows.length > 0 ? JSON.parse(rows[0].data) : {});
        }
        
        if (action === 'sign-cloudinary') {
            const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
            if (!cloudName || !apiKey || !apiSecret) {
                return res.status(500).json({ error: "Cloudinary configuration missing", fallback: true });
            }
            cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
            const timestamp = Math.round(new Date().getTime() / 1000);
            const signature = cloudinary.utils.api_sign_request({ folder: 'ACESOfilter', timestamp }, apiSecret);
            return res.status(200).json({ signature, apiKey, cloudName, timestamp, folder: 'ACESOfilter' });
        }

        if (action === 'trigger-ingest') {
            await triggerWorkflow("app/process.file", req.body);
            return res.status(200).json({ success: true });
        }

        if (!action) return res.status(200).json({ status: "API Online" });
        return res.status(404).json({ error: `Handler '${action}' not found` });
    } catch (e: any) {
        return res.status(500).json({ error: e.message });
    }
}
