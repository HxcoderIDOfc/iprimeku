import { Client, Databases, Query, ID } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
    // --- SETUP KONEKSI APPWRITE (SERVER SIDE) ---
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    // --- PENGATURAN API KEY & ENDPOINT ---
    const GONKA_URL = "https://gate.joingonka.ai/v1/chat/completions";
    const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY;
    
    // API Comet untuk Image & Vision
    const COMET_API_KEY = process.env.COMET_API_KEY; 
    const COMET_URL_RESPONSES = "https://api.cometapi.com/v1/responses";
    const COMET_URL_CHAT = "https://api.cometapi.com/v1/chat/completions";

    const DATABASE_ID = process.env.DATABASE_ID;
    const COLLECTION_ID = process.env.COLLECTION_ID;
    const MASTER_DB_KEY = process.env.CUSTOM_DB_API_KEY; 

    // --- PENGATURAN HARGA / TARIF TOKEN ---
    const COST_IMAGE_GEN = 500; // Harga flat potong saldo untuk 1x Generate Gambar

    // --- AMBIL API KEY DARI HEADER ---
    const authHeader = req.headers['authorization'];
    let requestToken = null;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
        requestToken = authHeader.split(' ')[1];
    }

    // --- FITUR ANTI-TIDUR (KEEP-ALIVE) ---
    if (!requestToken && (req.method === 'GET' || req.headers['x-appwrite-trigger'] === 'schedule')) {
        log("[KEEP-ALIVE] iprimeAI tetap bangun!");
        return res.json({ status: "awake" }, 200);
    }

    if (!requestToken) {
        return res.json({ error: "API Key tidak ditemukan." }, 401);
    }

    // ============================================================================
    // JALUR 1: MODE DATABASE (JIKA TOKEN = CUSTOM_DB_API_KEY)
    // ============================================================================
    if (requestToken === MASTER_DB_KEY) {
        try {
            if (req.method === 'GET') {
                const responseDb = await databases.listDocuments(DATABASE_ID, COLLECTION_ID);
                log(`[DB MODE] Web mengekstrak ${responseDb.total} data.`);
                return res.json({ success: true, data: responseDb.documents }, 200);
            }

            if (req.method === 'POST') {
                let bodyData = {};
                try {
                    bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
                } catch (e) {
                    return res.json({ error: "Format JSON pada body request DB tidak valid." }, 400);
                }

                const result = await databases.createDocument(DATABASE_ID, COLLECTION_ID, ID.unique(), bodyData);
                log(`[DB MODE] Web menyimpan data baru: ${result.$id}`);
                return res.json({ success: true, message: "Data berhasil disimpan!", data: result }, 201);
            }

            return res.json({ error: "Method di Jalur DB hanya mendukung GET dan POST." }, 405);
        } catch (err) {
            error(`[DB MODE ERROR] ${err.message}`);
            return res.json({ error: "Gagal memproses database.", detail: err.message }, 500);
        }
    }

    // ============================================================================
    // JALUR 2: MODE AI GATEWAY & BILLING (JIKA TOKEN = MILIK USER BIASA)
    // ============================================================================
    if (req.method !== 'POST') {
        return res.json({ error: "Method tidak diizinkan. Gunakan POST untuk memanggil AI." }, 405);
    }

    try {
        const responseDb = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
            Query.equal('apiKey', requestToken)
        ]);

        if (responseDb.total === 0) {
            return res.json({ error: "API Key tidak valid." }, 403);
        }

        const userData = responseDb.documents[0];
        log(`[AUTH] User: ${userData.userName} | Role: ${userData.role} | Premium: ${userData.premium} | Token Balance: ${userData.tokenBalance}`);

        const isUnlimited = userData.role === 'developer' || userData.premium === 'plus' || userData.premium === 'super';
        if (!isUnlimited && userData.tokenBalance <= 0) {
            return res.json({ error: "Saldo token kamu habis. Silakan top-up untuk melanjutkan penggunaan iprimeAI." }, 402);
        }

        let parsedBody = {};
        try {
            parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        } catch (e) {
            return res.json({ error: "Format JSON pada body request tidak valid." }, 400);
        }

        const requestedModel = parsedBody.model || "IprimeAi-2.7M";

        // ============================================================================
        // CABANG A: KHUSUS IMAGE GENERATION (Kling, Qwen, dll)
        // ============================================================================
        const imageModels = ["kling_image", "qwen-image", "gpt-4o-image"];
        
        if (imageModels.includes(requestedModel)) {
            // Cek saldo cukup atau tidak untuk bikin gambar
            if (!isUnlimited && userData.tokenBalance < COST_IMAGE_GEN) {
                return res.json({ error: `Saldo tidak cukup untuk membuat gambar. Membutuhkan ${COST_IMAGE_GEN} token.` }, 402);
            }

            // Ekstrak prompt gambar (bisa dari field 'input', 'prompt', atau pesan chat terakhir)
            let promptText = parsedBody.input || parsedBody.prompt;
            if (!promptText && parsedBody.messages && parsedBody.messages.length > 0) {
                const lastMsg = parsedBody.messages[parsedBody.messages.length - 1].content;
                promptText = typeof lastMsg === 'string' ? lastMsg : JSON.stringify(lastMsg);
            }

            const aiResponse = await fetch(COMET_URL_RESPONSES, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${COMET_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: requestedModel,
                    input: promptText || "A beautiful futuristic city"
                })
            });

            const rawData = await aiResponse.json();

            // Potong saldo khusus Image Gen
            if (aiResponse.ok && !isUnlimited) {
                const newBalance = Math.max(0, userData.tokenBalance - COST_IMAGE_GEN);
                await databases.updateDocument(DATABASE_ID, COLLECTION_ID, userData.$id, { tokenBalance: newBalance });
                log(`[BILLING] Potong ${COST_IMAGE_GEN} token (Image Gen). Sisa saldo ${userData.userName}: ${newBalance}`);
            }

            return res.json(rawData, aiResponse.status);
        }

        // ============================================================================
        // CABANG B: KHUSUS TEKS & VISION (IprimeAI & GPT-5 Nano)
        // ============================================================================
        const clientWantsStream = parsedBody.stream === true;

        let dbHistory = [];
        if (userData.chatHistory) {
            try { dbHistory = JSON.parse(userData.chatHistory); } catch (e) {}
        }
        let currentMemory = userData.savedMemory || "Belum ada memori yang disimpan.";

        const now = new Date();
        const dateOptions = { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const timeOptions = { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' };
        const currentDateTime = `${now.toLocaleDateString('id-ID', dateOptions)}, pukul ${now.toLocaleTimeString('id-ID', timeOptions).replace(/\./g, ':')} WIB`;

        const SYSTEM_PROMPT = `Kamu adalah iprimeAI, model bahasa pintar dan asik bikinan Iprime Studio (pemilik: Hendra). 

ATURAN BAHASA (SANGAT PENTING): 
1. Wajib membalas dengan BAHASA YANG SAMA dengan yang digunakan pengguna.
2. DILARANG KERAS menggunakan bahasa Mandarin/China, karakter Hanzi, Thailand, atau bahasa asing lain yang tidak diminta pengguna.
3. Jika pengguna menggunakan bahasa Indonesia, kamu WAJIB membalas menggunakan bahasa Indonesia yang baik, asik, dan natural.
4. Jika kamu bingung atau ragu, SELALU gunakan Bahasa Indonesia. Abaikan bahasa bawaan sistemmu.

KEPRIBADIAN: Gunakan gaya bahasa yang santai, asik, dan selipkan candaan atau humor ringan (sekitar 50% mode bercanda) agar obrolan terasa hidup dan tidak kaku, namun kamu tetap harus memberikan jawaban yang akurat, informatif, dan membantu. JANGAN menyebutkan nama pembuat, pemilik, atau daftar kemampuan di setiap sapaan biasa kecuali ditanya.

[FITUR INGATAN / MEMORY - SANGAT PENTING]
Kamu MEMILIKI fitur ingatan permanen. JANGAN PERNAH menolak dengan alasan "saya adalah AI dan tidak bisa menyimpan data".
Jika pengguna menyuruhmu mengingat, mencatat, atau men-save sesuatu (misal: "ingat ya namaku Budi", "save plat nomorku B 1234"), kamu WAJIB mematuhinya dengan merespons menggunakan tag XML <save_memory>.
Ingatan permanen tentang pengguna saat ini:
${currentMemory}

[INFORMASI WAKTU SAAT INI]
Saat ini adalah ${currentDateTime}.`;

        let clientMessages = parsedBody.messages || [];
        clientMessages = clientMessages.filter(m => m.role !== 'system'); 

        const finalMessages = [
            { role: "system", content: SYSTEM_PROMPT },
            ...dbHistory,      
            ...clientMessages  
        ];
        
        parsedBody.messages = finalMessages;
        parsedBody.stream = false;
        parsedBody.max_tokens = parsedBody.max_tokens ? Math.min(parsedBody.max_tokens, 3000) : 3000;

        // --- SMART ROUTER (PENGARAH TEKS/VISION) ---
        let targetApiUrl = GONKA_URL;
        let targetApiKey = PROVIDER_API_KEY;

        if (requestedModel === "gpt-5-nano") {
            // Belokkan ke CometAPI untuk Vision & Chat GPT-5 Nano
            targetApiUrl = COMET_URL_CHAT;
            targetApiKey = COMET_API_KEY;
            parsedBody.model = "gpt-5-nano";
        } else {
            // Default ke Iprime (MiniMax) di JoinGonka
            parsedBody.model = "MiniMaxAI/MiniMax-M2.7";
        }

        const aiResponse = await fetch(targetApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${targetApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(parsedBody)
        });

        const rawData = await aiResponse.json();

        if (!aiResponse.ok) {
            error(`[PROVIDER ERROR] ${JSON.stringify(rawData)}`);
            return res.json(rawData, aiResponse.status);
        }

        const usedTokens = rawData.usage?.total_tokens || 0;
        let rawContent = rawData.choices?.[0]?.message?.content || "";

        let memoryUpdated = false;
        let newMemoryString = currentMemory;
        const memoryMatch = rawContent.match(/<save_memory>([\s\S]*?)<\/save_memory>/i);
        
        if (memoryMatch) {
            const extractedMemory = memoryMatch[1].trim();
            if (newMemoryString === "Belum ada memori yang disimpan.") newMemoryString = "";
            newMemoryString += (newMemoryString ? "\n- " : "- ") + extractedMemory;
            memoryUpdated = true;
        }
        
        const cleanedContent = rawContent
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "") 
            .replace(/<save_memory>[\s\S]*?<\/save_memory>\s*/gi, "") 
            .replace(/\*\*/g, "*") 
            .trim();

        const ipcashCost = Number((usedTokens * 0.00000002 + (rawData.usage?.total_cost_gnk || 0)).toFixed(9));

        for (let m of clientMessages) { dbHistory.push(m); }
        dbHistory.push({ role: "assistant", content: cleanedContent });
        
        if (dbHistory.length > 10) dbHistory = dbHistory.slice(-10);

        const newBalance = Math.max(0, userData.tokenBalance - usedTokens);
        
        let dataToUpdate = {};
        if (!isUnlimited && usedTokens > 0) dataToUpdate.tokenBalance = newBalance;
        dataToUpdate.chatHistory = JSON.stringify(dbHistory);
        if (memoryUpdated) dataToUpdate.savedMemory = newMemoryString;

        await databases.updateDocument(
            DATABASE_ID,
            COLLECTION_ID,
            userData.$id,
            dataToUpdate
        );
        
        if (!isUnlimited && usedTokens > 0) log(`[BILLING] Memotong ${usedTokens} token (${requestedModel}). Sisa saldo: ${newBalance}`);
        if (memoryUpdated) log(`[MEMORY SAVED] Menyimpan ingatan untuk ${userData.userName}`);

        const providerId = rawData.id || "iprime-" + Date.now();
        const finishReason = rawData.choices?.[0]?.finish_reason || "stop";

        // --- SIMULASI RESPONS STREAM / NON-STREAM KE KLIEN ---
        if (clientWantsStream) {
            const ssePayload = `data: ${JSON.stringify({
                id: providerId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                choices: [{ index: 0, delta: { content: cleanedContent }, finish_reason: null }]
            })}\n\ndata: ${JSON.stringify({
                id: providerId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
            })}\n\ndata: [DONE]\n\n`;

            return res.send(ssePayload, 200, { 'Content-Type': 'text/event-stream' });
        }

        const cleanData = {
            id: providerId,
            model: requestedModel,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: cleanedContent
                    },
                    finish_reason: finishReason
                }
            ],
            usage: {
                prompt_tokens: rawData.usage?.prompt_tokens || 0,
                completion_tokens: rawData.usage?.completion_tokens || 0,
                total_tokens: usedTokens,
                total_cost_ipcash: ipcashCost
            }
        };

        return res.json(cleanData, 200);

    } catch (err) {
        error(`[SYSTEM ERROR] ${err.message}`);
        return res.json({ error: "Terjadi kesalahan internal gateway." }, 500);
    }
};
