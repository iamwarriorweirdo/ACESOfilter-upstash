
import { serve } from "@upstash/workflow/express";
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { redactPII, recursiveChunking } from '../utils/textProcessor';

// --- HELPERS ---
async function updateDbStatus(docId: string, message: string, isError = false) {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) return;
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const safeMessage = message.substring(0, 200); 
    const logLine = `[${timestamp}] ${isError ? '❌' : '⚡'} ${safeMessage}`;
    
    if (isError) {
        await sql`UPDATE documents SET extracted_content = ${logLine}, status = 'failed' WHERE id = ${docId}`;
    } else {
        await sql`UPDATE documents SET status = ${safeMessage.substring(0, 50)} WHERE id = ${docId}`;
    }
  } catch (e) { console.error("DB Log Error:", e); }
}

async function getEmbeddingWithFallback(ai: GoogleGenAI, text: string, primaryModel: string = 'embedding-001'): Promise<number[]> {
    try {
        const res = await ai.models.embedContent({
            model: "embedding-001",
            contents: { parts: [{ text }] }
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        console.error("Embedding failed:", e.message);
        return [];
    }
}

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
      txt: 'text/plain',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      csv: 'text/csv',
      md: 'text/md',
      html: 'text/html',
      xml: 'text/xml',
      rtf: 'text/rtf',
      py: 'text/x-python',
      js: 'text/javascript',
      ts: 'text/javascript'
  };
  return map[ext || ''] || 'application/octet-stream';
}

function isGeminiFileSupported(mimeType: string): boolean {
    const supported = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'text/html', 'text/css', 'text/md', 'text/csv', 'text/xml', 'text/rtf',
        'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'
    ];
    return supported.includes(mimeType) || mimeType.startsWith('image/');
}

// --- WORKFLOWS ---

export default serve(
  async (context) => {
    const { event, data } = context.requestPayload as any;
    
    if (event === "app/process.file") {
        await processFile(context, data);
    } else if (event === "app/delete.file") {
        await deleteFile(context, data);
    } else if (event === "app/sync.database") {
        // Sync logic if needed
    }
  }
);

async function processFile(context: any, data: any) {
    const { url, fileName, docId, reindexOnly } = data;
    if (!docId) return;

    try {
      const dbConfig = await context.run("1-get-config-db", async () => {
         const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
         const { neon } = await import('@neondatabase/serverless');
         const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
         
         const settings = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
         const docData = await sql`SELECT extracted_content, allowed_roles, full_text_content FROM documents WHERE id = ${docId}`;
         
         if (docData.length === 0) throw new Error("Document not found in DB");
         
         let allowedRoles = ['employee', 'hr', 'it', 'superadmin'];
         if (docData[0].allowed_roles) {
             try { allowedRoles = JSON.parse(docData[0].allowed_roles); } catch(e){}
         }

         return { 
             config: settings.length > 0 ? JSON.parse(settings[0].data) : {},
             doc: docData[0],
             allowedRoles
         };
      });

      // --- RE-INDEX MODE (RBAC Update Only) ---
      if (reindexOnly) {
           await context.run("reindex-rbac", async () => {
              if (process.env.PINECONE_API_KEY) {
                  await updateDbStatus(docId, `Cập nhật quyền truy cập...`);
                  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
                  const index = pc.index(process.env.PINECONE_INDEX_NAME!);
                  
                  const list = await index.listPaginated({ prefix: docId });
                  if (list.vectors) {
                      for (const v of list.vectors) {
                           if (v.id) {
                                await index.update({
                                    id: v.id,
                                    metadata: { allowed_roles: dbConfig.allowedRoles }
                                });
                           }
                      }
                  }
                  await updateDbStatus(docId, `Cập nhật quyền hoàn tất.`);
              }
           });
           return;
      }

      // --- FULL PROCESSING MODE ---
      if (!url) return;

      const ingestionApiKey = process.env.OCR_API_KEY || dbConfig.config.ocrApiKey || process.env.API_KEY || "";
      if (!ingestionApiKey) throw new Error("Missing API Key for OCR");

      const strategy = await context.run("2-check-strategy", async () => {
          await updateDbStatus(docId, `Kiểm tra file...`);
          try {
              const headRes = await fetch(url, { method: 'HEAD' });
              const size = Number(headRes.headers.get('content-length') || 0);
              return { size, isLarge: size > 10 * 1024 * 1024 }; 
          } catch (e) {
              return { size: 0, isLarge: true };
          }
      });

      const ocrResult = await context.run("3-smart-ocr", async () => {
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          const mimeType = getMimeType(fileName || "doc");
          const isSupported = isGeminiFileSupported(mimeType);

          let ocrModel = dbConfig.config.ocrModel || 'auto';
          if (ocrModel === 'auto') {
              ocrModel = 'gemini-3-flash-preview';
          }

          if (strategy.isLarge) {
              await updateDbStatus(docId, `File lớn. Đang xử lý Stream...`);
              const tempFilePath = path.join(os.tmpdir(), `partial_${docId}_${Date.now()}.${(fileName || "file").split('.').pop()}`);
              
              try {
                  const response = await fetch(url);
                  if (!response.ok || !response.body) throw new Error("Download failed");
                  const nodeStream = Readable.fromWeb(response.body as any);
                  await pipeline(nodeStream, fs.createWriteStream(tempFilePath));

                  if (isSupported) {
                      let googleFile: any = null;
                      try {
                          await updateDbStatus(docId, `Đẩy file sang Google AI...`);
                          const uploadResult = await genAI.files.upload({
                              file: tempFilePath,
                              config: { mimeType }
                          });
                          googleFile = uploadResult;

                          let fileState = googleFile.state;
                          while (fileState === "PROCESSING") {
                              await new Promise(r => setTimeout(r, 2000));
                              const freshFile = await genAI.files.get({ name: googleFile.name });
                              fileState = freshFile.state;
                          }
                          
                          await updateDbStatus(docId, `AI đang phân tích...`);
                          const result = await genAI.models.generateContent({
                              model: ocrModel,
                              contents: {
                                  parts: [
                                      { fileData: { fileUri: googleFile.uri, mimeType } },
                                      { text: "Trích xuất toàn bộ nội dung văn bản quan trọng từ tài liệu này." }
                                  ]
                              }
                          });

                          return { text: result.text || "", method: `gemini-file-api-${ocrModel}`, isPartial: true };
                      } finally {
                          try { if (googleFile) await genAI.files.delete({ name: googleFile.name }); } catch (e) {}
                      }
                  } else {
                      let text = "";
                      if (fileName?.endsWith('.docx')) {
                           const result = await mammoth.extractRawText({ path: tempFilePath });
                           text = result.value;
                      } else if (fileName?.endsWith('.xlsx')) {
                           const workbook = XLSX.readFile(tempFilePath);
                           text = XLSX.utils.sheet_to_txt(workbook.Sheets[workbook.SheetNames[0]]);
                      }
                      return { text: text.substring(0, 50000), method: "local-extract", isPartial: true };
                  }
              } finally {
                  try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
              }
          } else {
              const res = await fetch(url);
              const buffer = Buffer.from(await res.arrayBuffer());
              const base64 = buffer.toString('base64');
              
              let text = "";
              if (isSupported) {
                   await updateDbStatus(docId, `AI đang quét nội dung...`);
                   const resAi = await genAI.models.generateContent({
                        model: ocrModel,
                        contents: {
                            parts: [
                                { inlineData: { data: base64, mimeType } },
                                { text: "Trích xuất nội dung văn bản chính." }
                            ]
                        }
                    });
                    text = resAi.text || "";
              }
              return { text: text.substring(0, 80000), method: ocrModel, isPartial: false };
          }
      });

      const cleanText = await context.run("4-pii-redaction", async () => {
          if (!ocrResult.text) return "";
          await updateDbStatus(docId, `Đang ẩn danh dữ liệu (PII)...`);
          return redactPII(ocrResult.text);
      });

      const metaResult = await context.run("5-analyze-metadata", async () => {
          if (!cleanText) return { title: fileName, summary: "Lỗi đọc nội dung." };
          await updateDbStatus(docId, `AI chuẩn hóa Index...`);
          
          let analysisModel = dbConfig.config.analysisModel || 'auto';
          if (analysisModel === 'auto') analysisModel = 'gemini-3-flash-preview';

          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          try {
              const res = await genAI.models.generateContent({
                  model: analysisModel,
                  contents: `Phân tích văn bản (đã che PII) sau và trả về JSON: { "title": "Tiêu đề", "summary": "Tóm tắt ngắn", "language": "vi/en", "key_information": ["ý chính 1", "ý chính 2"] }. Dữ liệu: ${cleanText.substring(0, 10000)}`,
                  config: { responseMimeType: "application/json" }
              });
              return JSON.parse(res.text || "{}");
          } catch (e) {
              return { title: fileName, summary: "AI Analysis Failed" };
          }
      });

      await context.run("6-save-db", async () => {
          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          const finalContent = {
              ...metaResult,
              full_text_content: cleanText, 
              parse_method: ocrResult.method,
              is_partial_index: ocrResult.isPartial 
          };
          
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify(finalContent)}, status = 'indexed' WHERE id = ${docId}`;
      });

      await context.run("7-vectorize-chunks", async () => {
          if (!cleanText || cleanText.length < 10) return;
          await updateDbStatus(docId, `Cắt Chunk & Vector hóa...`);
          
          const chunks = recursiveChunking(cleanText, 1000, 200);
          
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          const embeddingModel = dbConfig.config.embeddingModel || 'embedding-001';
          
          if (process.env.PINECONE_API_KEY) {
              const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
              const index = pc.index(process.env.PINECONE_INDEX_NAME!);

              const BATCH_SIZE = 5;
              for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
                  const batch = chunks.slice(i, i + BATCH_SIZE);
                  const vectorsToUpsert = [];

                  for (let j = 0; j < batch.length; j++) {
                      const chunkText = batch[j];
                      const vector = await getEmbeddingWithFallback(genAI, chunkText, embeddingModel);
                      if (vector.length > 0) {
                          vectorsToUpsert.push({
                              id: `${docId}_chk_${i + j}`,
                              values: vector,
                              metadata: { 
                                  filename: fileName, 
                                  text: chunkText,
                                  doc_id: docId,
                                  allowed_roles: dbConfig.allowedRoles
                              }
                          });
                      }
                  }

                  if (vectorsToUpsert.length > 0) {
                      await index.upsert(vectorsToUpsert as any);
                  }
                  
                  await new Promise(r => setTimeout(r, 1000));
              }
              await updateDbStatus(docId, `Hoàn tất (${chunks.length} chunks).`);
          }
      });

    } catch (e: any) {
        await updateDbStatus(docId, `Lỗi: ${e.message}`, true);
        throw e;
    }
}

async function deleteFile(context: any, data: any) {
    const { docId } = data;
    await context.run("delete-pinecone", async () => {
         if (process.env.PINECONE_API_KEY) {
             try {
                 const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
                 const index = pc.index(process.env.PINECONE_INDEX_NAME!);
                 await index.deleteMany({ filter: { doc_id: { $eq: docId } } }); 
             } catch (e) { console.error("Pinecone delete error", e); }
         }
    });
}
