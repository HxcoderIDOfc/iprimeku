import { Client, Databases, Query, ID } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
    // --- SETUP KONEKSI APPWRITE (SERVER SIDE) ---
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    const PROVIDER_URL = "https://gate.joingonka.ai/v1/chat/completions";
    const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY;
    const DATABASE_ID = process.env.DATABASE_ID;
    const COLLECTION_ID = process.env.COLLECTION_ID;
    
    // API KEY KHUSUS DB (Tambahkan variabel CUSTOM_DB_API_KEY di ENV Appwrite)
    const MASTER_DB_KEY = process.env.CUSTOM_DB_API_KEY; 

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
            // MODE BACA (GET) -> Ambil semua data user dari DB
            if (req.method === 'GET') {
                const responseDb = await databases.listDocuments(DATABASE_ID, COLLECTION_ID);
                log(`[DB MODE] Web mengekstrak ${responseDb.total} data.`);
                return res.json({ success: true, data: responseDb.documents }, 200);
            }

            // MODE TULIS (POST) -> Simpan data user baru ke DB
            if (req.method === 'POST') {
                let bodyData = {};
                try {
                    bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
                } catch (e) {
                    return res.json({ error: "Format JSON pada body request DB tidak valid." }, 400);
                }

                const result = await databases.createDocument(
                    DATABASE_ID,
                    COLLECTION_ID,
                    ID.unique(), // Bikin ID otomatis untuk user baru
                    bodyData
                );
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

        // --- TARIK RIWAYAT & MEMORY DARI DATABASE ---
        let dbHistory = [];
        if (userData.chatHistory) {
            try { dbHistory = JSON.parse(userData.chatHistory); } catch (e) {}
        }
        let currentMemory = userData.savedMemory || "Belum ada memori yang disimpan.";

        const now = new Date();
        const dateOptions = { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const timeOptions = { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' };
        const currentDateTime = `${now.toLocaleDateString('id-ID', dateOptions)}, pukul ${now.toLocaleTimeString('id-ID', timeOptions).replace(/\./g, ':')} WIB`;

        // --- UPDATE SYSTEM PROMPT: LARANGAN KERAS & INSTRUKSI MEMORY ---
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
Contoh balasanmu jika disuruh mengingat:
<save_memory>Nama pengguna adalah Budi. Plat nomor B 1234.</save_memory>
Siap! Udah aku catet dan simpan di otakku ya!

Ingatan permanen tentang pengguna saat ini:
${currentMemory}

[INFORMASI WAKTU SAAT INI]
Saat ini adalah ${currentDateTime}.`;

        // --- GABUNGKAN HISTORY DB DENGAN PESAN BARU ---
        let clientMessages = parsedBody.messages || [];
        clientMessages = clientMessages.filter(m => m.role !== 'system'); // Hapus system prompt dari client kalau ada

        const finalMessages = [
            { role: "system", content: SYSTEM_PROMPT },
            ...dbHistory,      // Masukkan riwayat obrolan terdahulu
            ...clientMessages  // Masukkan pesan terbaru dari user
        ];
        
        parsedBody.messages = finalMessages;

        if (parsedBody.model === "IprimeAi-2.7M" || !parsedBody.model) {
            parsedBody.model = "MiniMaxAI/MiniMax-M2.7";
        }

        // --- LIMIT TOKEN LEBIH PANJANG (3000 Token) ---
        parsedBody.max_tokens = parsedBody.max_tokens ? Math.min(parsedBody.max_tokens, 3000) : 3000;

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

        // --- TANGKAP TAG MEMORY DARI JAWABAN AI ---
        let memoryUpdated = false;
        let newMemoryString = currentMemory;
        const memoryMatch = rawContent.match(/<save_memory>([\s\S]*?)<\/save_memory>/i);
        
        if (memoryMatch) {
            const extractedMemory = memoryMatch[1].trim();
            if (newMemoryString === "Belum ada memori yang disimpan.") newMemoryString = "";
            newMemoryString += (newMemoryString ? "\n- " : "- ") + extractedMemory;
            memoryUpdated = true;
        }
        
        // --- HAPUS THINK, TAG MEMORY (AGAR USER TIDAK LIHAT), & UBAH BINTANG ---
        const cleanedContent = rawContent
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "") // Hapus tag think
            .replace(/<save_memory>[\s\S]*?<\/save_memory>\s*/gi, "") // Sembunyikan tag save dari user
            .replace(/\*\*/g, "*") // Ubah **bold** jadi *bold*
            .trim();

        const ipcashCost = Number((usedTokens * 0.00000002 + (rawData.usage?.total_cost_gnk || 0)).toFixed(9));

        // --- UPDATE HISTORY BARU (Maksimal 10 Pesan Terakhir) ---
        for (let m of clientMessages) { dbHistory.push(m); }
        dbHistory.push({ role: "assistant", content: cleanedContent });
        
        // Ambil 10 pesan terakhir saja agar tidak kepanjangan
        if (dbHistory.length > 10) dbHistory = dbHistory.slice(-10);

        // --- SISTEM UPDATE DB (BILLING, HISTORY, & MEMORY) ---
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
        
        if (!isUnlimited && usedTokens > 0) log(`[BILLING] Memotong ${usedTokens} token. Sisa saldo ${userData.userName}: ${newBalance}`);
        if (memoryUpdated) log(`[MEMORY SAVED] Menyimpan ingatan untuk ${userData.userName}`);

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

        return res.json(cleanData, 200);

    } catch (err) {
        error(`[SYSTEM ERROR] ${err.message}`);
        return res.json({ error: "Terjadi kesalahan internal gateway." }, 500);
    }
};
