import { Client, Databases, Query } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
    // --- FITUR ANTI-TIDUR (KEEP-ALIVE) ---
    if (req.method === 'GET' || req.headers['x-appwrite-trigger'] === 'schedule') {
        log("[KEEP-ALIVE] iprimeAI tetap bangun!");
        return res.json({ status: "awake" }, 200);
    }

    const PROVIDER_URL = "https://gate.joingonka.ai/v1/chat/completions";
    const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY;
    const DATABASE_ID = process.env.DATABASE_ID;
    const COLLECTION_ID = process.env.COLLECTION_ID;

    if (req.method !== 'POST') {
        return res.json({ error: "Method tidak diizinkan. Gunakan POST." }, 405);
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.json({ error: "API Key tidak ditemukan." }, 401);
    }

    const userToken = authHeader.split(' ')[1];

    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    try {
        const responseDb = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
            Query.equal('apiKey', userToken)
        ]);

        if (responseDb.total === 0) {
            return res.json({ error: "API Key tidak valid." }, 403);
        }

        const userData = responseDb.documents[0];
        log(`[AUTH] User: ${userData.userName} | Role: ${userData.role} | Premium: ${userData.premium} | Token Balance: ${userData.tokenBalance}`);

        const isUnlimited = userData.role === 'developer' || userData.premium === 'plus' || userData.premium === 'super';
        if (!isUnlimited && userData.tokenBalance <= 0) {
            return res.json({ 
                error: "Saldo token kamu habis. Silakan top-up untuk melanjutkan penggunaan iprimeAI." 
            }, 402);
        }

        // --- AMAN: PARSING BODY DENGAN TRY-CATCH ---
        let parsedBody = {};
        try {
            parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        } catch (e) {
            return res.json({ error: "Format JSON pada body request tidak valid." }, 400);
        }

        const now = new Date();
        const dateOptions = { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const timeOptions = { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' };
        const currentDateTime = `${now.toLocaleDateString('id-ID', dateOptions)}, pukul ${now.toLocaleTimeString('id-ID', timeOptions).replace(/\./g, ':')} WIB`;

        const SYSTEM_PROMPT = `Kamu adalah iprimeAI, model bahasa pintar bikinan Iprime Studio (pemilik: Hendra). 
ATURAN BAHASA: Gunakan BAHASA YANG SAMA PERSIS dengan bahasa yang digunakan pengguna pada pesan terakhirnya. Jika pengguna memakai bahasa Indonesia, kamu wajib membalas dalam bahasa Indonesia. Jika pengguna memakai bahasa Inggris, balas dalam bahasa Inggris. Jangan mencampur atau tiba-tiba berganti bahasa.
Aturan Identitas: JANGAN PERNAH menyebutkan identitas asli dari provider lain. JANGAN menyebutkan nama pembuat, pemilik, atau daftar kemampuan di setiap sapaan biasa. Balaslah secara ramah, natural, dan langsung ke inti. Kamu baru boleh menyebutkan detail penciptamu jika pengguna bertanya secara spesifik tentang identitas/siapa pembuatmu.

[INFORMASI WAKTU SAAT INI]
Saat ini adalah ${currentDateTime}. Gunakan informasi ini HANYA jika pengguna menanyakan tentang waktu, jam, hari, atau tanggal.`;

        // --- AMAN: CEK PANJANG ARRAY MESSAGES SEBELUM DIAKSES ---
        if (parsedBody.messages && Array.isArray(parsedBody.messages)) {
            if (parsedBody.messages.length > 0 && parsedBody.messages[0].role === 'system') {
                parsedBody.messages[0].content += `\n\nInstruksi Penting:\n${SYSTEM_PROMPT}`;
            } else {
                parsedBody.messages.unshift({ role: "system", content: SYSTEM_PROMPT });
            }
        } else {
            parsedBody.messages = [{ role: "system", content: SYSTEM_PROMPT }];
        }

        if (parsedBody.model === "IprimeAi-2.7M" || !parsedBody.model) {
            parsedBody.model = "MiniMaxAI/MiniMax-M2.7";
        }

        const bodyData = JSON.stringify(parsedBody);

        const aiResponse = await fetch(PROVIDER_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PROVIDER_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: bodyData
        });

        const rawData = await aiResponse.json();

        if (!aiResponse.ok) {
            error(`[PROVIDER ERROR] ${JSON.stringify(rawData)}`);
            return res.json(rawData, aiResponse.status);
        }

        const usedTokens = rawData.usage?.total_tokens || 0;
        
        let rawContent = rawData.choices?.[0]?.message?.content || "";
        const cleanedContent = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

        const ipcashCost = Number((usedTokens * 0.00000002 + (rawData.usage?.total_cost_gnk || 0)).toFixed(9));

        const cleanData = {
            id: rawData.id || "iprime-" + Date.now(),
            model: "IprimeAi-2.7M",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: cleanedContent
                    },
                    finish_reason: rawData.choices?.[0]?.finish_reason || "stop"
                }
            ],
            usage: {
                prompt_tokens: rawData.usage?.prompt_tokens || 0,
                completion_tokens: rawData.usage?.completion_tokens || 0,
                total_tokens: usedTokens,
                total_cost_ipcash: ipcashCost
            }
        };

        // --- SISTEM PEMOTONGAN TOKEN (BILLING) ---
        if (!isUnlimited && usedTokens > 0) {
            const newBalance = Math.max(0, userData.tokenBalance - usedTokens);
            
            await databases.updateDocument(
                DATABASE_ID,
                COLLECTION_ID,
                userData.$id,
                {
                    tokenBalance: newBalance
                }
            );
            log(`[BILLING] Memotong ${usedTokens} token. Sisa saldo ${userData.userName}: ${newBalance}`);
        }

        return res.json(cleanData, 200);

    } catch (err) {
        error(`[SYSTEM ERROR] ${err.message}`);
        return res.json({ error: "Terjadi kesalahan internal gateway." }, 500);
    }
};
