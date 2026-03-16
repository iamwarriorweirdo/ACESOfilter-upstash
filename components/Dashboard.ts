
import React, { useState, useEffect, useCallback } from 'react';
import { Document, Folder, User, SystemConfig, Language, ChatSession, Message } from '../types';
import AdminView from './AdminView';
import UserView from './UserView';
import { TRANSLATIONS } from '../constants';

interface DashboardProps {
  user: User;
  onLogout: () => void;
}

const Dashboard: React.FC<DashboardProps> = ({ user, onLogout }) => {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [config, setConfig] = useState<SystemConfig>({
    ocrModel: 'auto',
    embeddingModel: 'embedding-001',
    analysisModel: 'auto',
    chatModel: 'auto',
    maxFileSizeMB: 100,
    ocrApiKey: ''
  });
  const [language, setLanguage] = useState<Language>((localStorage.getItem('aceso_lang') as Language) || 'vi');
  const [isUploading, setIsUploading] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);

  const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;

  const fetchData = useCallback(async () => {
    try {
      const [docsRes, foldersRes, configRes, sessionsRes] = await Promise.all([
        fetch('/api/app?handler=files'),
        fetch('/api/app?handler=folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list' })
        }),
        fetch('/api/app?handler=config'),
        fetch(`/api/app?handler=chats&username=${user.username}`)
      ]);

      const [docsData, foldersData, configData, sessionsData] = await Promise.all([
        docsRes.json(),
        foldersRes.json(),
        configRes.json(),
        sessionsRes.json()
      ]);

      setDocuments(docsData);
      setFolders(foldersData.folders || []);
      if (Object.keys(configData).length > 0) setConfig(configData);
      setSessions(sessionsData.sessions || []);
    } catch (error) {
      console.error("Failed to fetch dashboard data:", error);
    }
  }, [user.username]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleUpdateConfig = async (newConfig: SystemConfig) => {
    try {
      await fetch('/api/app?handler=config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });
      setConfig(newConfig);
    } catch (error) {
      console.error("Failed to update config:", error);
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // 1. Check for duplicates
        const isDuplicate = documents.some(d => d.name === file.name && d.size === file.size);
        if (isDuplicate && !confirm(t.duplicateWarning)) continue;

        // 2. Get upload signature/url
        const signRes = await fetch('/api/app?handler=sign-cloudinary');
        const signData = await signRes.json();

        let uploadUrl = '';
        let publicUrl = '';

        if (signData.fallback) {
          // Fallback to Supabase if Cloudinary is not configured
          const sbRes = await fetch('/api/app?handler=upload-supabase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name })
          });
          const sbData = await sbRes.json();
          if (sbData.error) throw new Error(sbData.error);
          
          await fetch(sbData.uploadUrl, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type }
          });
          publicUrl = sbData.publicUrl;
        } else {
          // Upload to Cloudinary
          const formData = new FormData();
          formData.append('file', file);
          formData.append('api_key', signData.apiKey);
          formData.append('timestamp', signData.timestamp.toString());
          formData.append('signature', signData.signature);
          formData.append('folder', signData.folder);

          const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${signData.cloudName}/auto/upload`, {
            method: 'POST',
            body: formData
          });
          const cloudData = await cloudRes.json();
          publicUrl = cloudData.secure_url;
        }

        // 3. Save metadata to DB
        const docId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const newDoc: Partial<Document> = {
          id: docId,
          name: file.name,
          type: file.type || 'application/octet-stream',
          content: publicUrl,
          size: file.size,
          uploadDate: Date.now(),
          uploadedBy: user.username,
          status: 'pending',
          allowedRoles: ['employee', 'hr', 'it', 'superadmin']
        };

        await fetch('/api/app?handler=files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newDoc)
        });

        // 4. Trigger Ingest Workflow
        await fetch('/api/app?handler=trigger-ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: publicUrl,
            fileName: file.name,
            docId: docId
          })
        });
      }
      
      await fetchData();
    } catch (error: any) {
      alert("Upload failed: " + error.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleUpdateFolder = async (folder: Partial<Folder>, action: 'create' | 'update' | 'delete') => {
    try {
      await fetch('/api/app?handler=folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...folder, action })
      });
      await fetchData();
    } catch (error) {
      console.error(`Folder ${action} failed:`, error);
    }
  };

  const handleDeleteDocument = async (id: string) => {
    if (!confirm("Bạn có chắc chắn muốn xóa tài liệu này?")) return;
    try {
      await fetch('/api/app?handler=files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      await fetchData();
    } catch (error) {
      console.error("Delete document failed:", error);
    }
  };

  const handleUpdateDocument = async (docId: string, newContent: string) => {
    try {
      await fetch('/api/app?handler=files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: docId, extractedContent: newContent })
      });
      await fetchData();
    } catch (error) {
      console.error("Update document failed:", error);
    }
  };

  const isAdmin = user.role === 'superadmin' || user.role === 'hr' || user.role === 'it';

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
      {isAdmin ? (
        <AdminView 
          documents={documents}
          folders={folders}
          config={config}
          setConfig={handleUpdateConfig}
          onUpload={handleUpload}
          onDeleteDocument={handleDeleteDocument}
          onUpdateDocument={handleUpdateDocument}
          onUpdateFolder={handleUpdateFolder}
          isUploading={isUploading}
          language={language}
          setLanguage={(lang) => {
            setLanguage(lang);
            localStorage.setItem('aceso_lang', lang);
          }}
          user={user}
          onLogout={onLogout}
        />
      ) : (
        <UserView 
          documents={documents}
          folders={folders}
          language={language}
          setLanguage={(lang) => {
            setLanguage(lang);
            localStorage.setItem('aceso_lang', lang);
          }}
          user={user}
          onLogout={onLogout}
          sessions={sessions}
          setSessions={setSessions}
        />
      )}
    </div>
  );
};

export default Dashboard;
