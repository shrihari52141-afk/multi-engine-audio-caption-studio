export async function onRequestPost(context) {
  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    const deepgramKey = formData.get('deepgramApiKey');
    const geminiKeysRaw = formData.get('geminiApiKey'); // Can be single key or comma/newline separated
    const geminiModel = formData.get('geminiModel') || 'gemini-2.5-flash';
    const scriptMode = formData.get('scriptMode') || 'native';
    const spokenLang = formData.get('spokenLang') || 'en';
    const enableHighlight = formData.get('enableHighlight') === 'true';
    const enableEmojis = formData.get('enableEmojis') === 'true';

    if (!file || !deepgramKey || !geminiKeysRaw) {
      return new Response(JSON.stringify({ error: 'Missing required parameters (file, Deepgram key, or Gemini key).' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const arrayBuffer = await file.arrayBuffer();

    // 1. Dispatch Pass 1 to Deepgram Nova-3 API over Cloudflare high-speed fiber
    let dgUrl = `https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=true&word_timestamps=true`;
    if (spokenLang) {
      dgUrl += `&language=${encodeURIComponent(spokenLang)}`;
    }

    const authHeader = deepgramKey.toLowerCase().startsWith('token ') ? deepgramKey : `Token ${deepgramKey}`;
    const dgPromise = fetch(dgUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': file.type || 'audio/mp3'
      },
      body: arrayBuffer
    }).then(async res => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Deepgram API error (${res.status}): ${text}`);
      }
      return res.json();
    });

    // 2. Convert ArrayBuffer to Base64 in RAM for Gemini payload
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const len = bytes.byteLength;
    const chunkSize = 0x8000;
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const base64Audio = btoa(binary);

    // Wait for Deepgram response
    const dgResult = await dgPromise;
    const dgWords = dgResult.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    const roughWords = dgWords.map(w => ({
      word: w.punctuated_word || w.word,
      start: Math.round(w.start * 1000),
      end: Math.round(w.end * 1000)
    }));

    // 3. Prepare Gemini Prompt with Highlight & Emoji Instructions
    const scriptPromptMap = {
      native: `transcribe the spoken words in the NATIVE SCRIPT of language code '${spokenLang}' (e.g. தமிழ், ಕನ್ನಡ, हिंदी).`,
      tanglish: `transcribe the spoken words in ROMANIZED / TANGLISH phonetic script using English letters (e.g. "Maanu", "Thappa", "Nee sari kadaiyathu").`,
      english: `translate the audio accurately into ENGLISH words.`
    };

    const targetScriptInstruction = scriptPromptMap[scriptMode] || scriptPromptMap.native;

    let extraInstructions = "";
    if (enableHighlight) {
      extraInstructions += `\n5. IDENTIFY NAMES & EXPRESSIONS: Set "highlight": true for proper names (e.g., "Zara", "Shrihari"), sudden vocal interjections, or exclamations ("Aiyo!", "Wow!", "Ahaa!"). Otherwise set "highlight": false.`;
    }
    if (enableEmojis) {
      extraInstructions += `\n6. SMART CONTEXTUAL EMOJIS: Append 1 perfect, relevant emoji ONLY to key emotive words, sudden expressions, or main nouns (e.g., "Zara 👧", "Aiyo! 😱", "Super 🔥", "Love ❤️"). NEVER add emojis to routine words like "and", "the", "is".`;
    }

    const systemPrompt = `You are an expert speech-to-text word corrector and high-speed acoustic alignment engine.

INPUT DATA:
1. Audio file.
2. Pass 1 rough draft word timestamps: ${JSON.stringify(roughWords)}

STRICT CONTINUOUS FULL-TRACK ALIGNMENT RULES:
1. Target Script: ${targetScriptInstruction}
2. CONTINUOUS FULL-TRACK MANDATE: You MUST ensure 100% uniform timestamp accuracy across all sections of the audio.
3. Align every word's start/end timestamps directly to the speaker's vocal speed in the audio track.
4. Correct wrong/misspelled words from Pass 1 while preserving exact vocal onset and offset sound bounds.${extraInstructions}

Return ONLY a valid JSON array of objects with keys "word" (string), "start" (integer ms), "end" (integer ms), and "highlight" (boolean).`;

    const geminiReqBody = {
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: file.type || "audio/mp3",
              data: base64Audio
            }
          },
          { text: systemPrompt }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              word: { type: "STRING" },
              start: { type: "INTEGER" },
              end: { type: "INTEGER" },
              highlight: { type: "BOOLEAN" }
            },
            required: ["word", "start", "end"]
          }
        }
      }
    };

    // Failover Shuffle Execution over Gemini Keys
    const geminiKeys = geminiKeysRaw.split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
    const shuffledKeys = [...geminiKeys].sort(() => Math.random() - 0.5);

    let rawGeminiResult = null;
    let lastErr = null;

    for (let i = 0; i < shuffledKeys.length; i++) {
      const currentKey = shuffledKeys[i];
      try {
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${currentKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiReqBody)
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          throw new Error(`Gemini API Error (${geminiRes.status}): ${errText}`);
        }

        const geminiData = await geminiRes.json();
        const candidateText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!candidateText) throw new Error('No valid response generated by Gemini.');

        rawGeminiResult = JSON.parse(candidateText);
        break; // Success!
      } catch (err) {
        lastErr = err;
      }
    }

    if (!rawGeminiResult) {
      throw new Error(`All ${shuffledKeys.length} Gemini keys failed: ${lastErr ? lastErr.message : 'Unknown error'}`);
    }

    return new Response(JSON.stringify({
      dgResult,
      roughWords,
      rawGeminiResult
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
