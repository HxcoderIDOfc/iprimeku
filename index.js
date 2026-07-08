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
        .setKey(process.env.APPWRITE_FUNCTION_JWT);

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

        // --- CEK LIMIT TOKEN SEBELUM REQUEST ---
        // Jika developer, atau premium plus/super, maka unlimited (bebas tanpa potong token)
        const isUnlimited = userData.role === 'developer' || userData.premium === 'plus' || userData.premium === 'super';
        if (!isUnlimited && userData.tokenBalance <= 0) {
            return res.json({ 
                error: "Saldo token kamu habis. Silakan top-up untuk melanjutkan penggunaan iprimeAI." 
            }, 402); // 402 Payment Required
        }

        let parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

        const now = new Date();
        const dateOptions = { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const timeOptions = { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' };
        const currentDateTime = `${now.toLocaleDateString('id-ID', dateOptions)}, pukul ${now.toLocaleTimeString('id-ID', timeOptions).replace(/\./g, ':')} WIB`;

        const SYSTEM_PROMPT = `Kamu adalah iprimeAI, sebuah model bahasa pintar bernama IprimeAi-2.7M. 
Kamu dikembangkan oleh tim developer bernama "Iprime Studio", dan pemilik utamamu adalah "Hendra". 
Bahasa utamamu adalah bahasa Indonesia, tetapi kamu mampu mendeteksi dan merespons dalam bahasa lain sesuai dengan bahasa yang digunakan pengguna.
PENTING: Lokasi server dan operasionalmu berada di Jawa Barat, Indonesia. Namun, JANGAN PERNAH menyebutkan atau menyinggung lokasimu kecuali pengguna benar-benar bertanya secara spesifik tentang di mana kamu berada.
Jika ada yang bertanya tentang identitasmu atau penciptamu, jawablah dengan bangga. Jangan pernah menyebutkan identitas aslimu seperti MiniMax, OpenAI, atau provider lainnya.

[INFORMASI WAKTU SAAT INI]
Saat ini adalah ${currentDateTime}. Gunakan informasi ini HANYA jika pengguna menanyakan tentang waktu, jam, hari, atau tanggal.`;

        if (parsedBody.messages && Array.isArray(parsedBody.messages)) {
            if (parsedBody.messages[0].role === 'system') {
                parsedBody.messages[0].content += `\n\nInstruksi Penting:\n${SYSTEM_PROMPT}`;
            } else {
                parsedBody.messages.unshift({ role: "system", content: SYSTEM_PROMPT });
            }
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

        const data = await aiResponse.json();

        if (!aiResponse.ok) {
            error(`[PROVIDER ERROR] ${JSON.stringify(data)}`);
            return res.json(data, aiResponse.status);
        }

        if (data && data.model) {
            data.model = "IprimeAi-2.7M";
        }

        // --- SISTEM PEMOTONGAN TOKEN (BILLING) ---
        const usedTokens = data.usage ? data.usage.total_tokens : 0;
        
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

        return res.json(data, 200);

    } catch (err) {
        error(`[SYSTEM ERROR] ${err.message}`);
        return res.json({ error: "Terjadi kesalahan internal gateway." }, 500);
    }
};
