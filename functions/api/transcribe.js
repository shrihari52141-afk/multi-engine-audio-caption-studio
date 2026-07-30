export async function onRequestPost(context) {
  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    const deepgramKey = formData.get('deepgramApiKey');
    const geminiKeysRaw = formData.get('geminiApiKey');
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

    // 1. Pass 1: High-Precision Deepgram Nova-3 API Call (with filler_words=true & diarize=true)
    let dgUrl = `https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=true&word_timestamps=true&filler_words=true&diarize=true`;
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

    // 2. Prepare Base64 in RAM for Gemini payload
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const len = bytes.byteLength;
    const chunkSize = 0x8000;
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const base64Audio = btoa(binary);

    // 3. Prepare Gemini Master Alignment & Semantic Tagging Prompt
    const scriptPromptMap = {
      native: `transcribe the spoken words in the NATIVE SCRIPT of language code '${spokenLang}' (e.g. தமிழ், ಕನ್ನಡ, हिंदी).`,
      tanglish: `transcribe the spoken words in ROMANIZED / TANGLISH phonetic script using English letters (e.g. "Maanu", "Thappa", "Nee sari kadaiyathu").`,
      english: `translate the audio accurately into ENGLISH words.`
    };

    const targetScriptInstruction = scriptPromptMap[scriptMode] || scriptPromptMap.native;

    let extraInstructions = "";
    if (enableHighlight) {
      extraInstructions += `\n- ` + '`is_expression`: Mark TRUE ONLY for standalone exclamations, interjections, or isolated expressions (e.g., "Shut up", "Oh god", "Aiyo!", "Wow!", "Super").';
      extraInstructions += `\n- ` + '`is_name`: Mark TRUE for proper nouns, person names, or brand names (e.g., "Zara", "Shrihari", "Ani Cabs").';
      extraInstructions += `\n- ` + '`highlight`: Set TRUE for names, exclamations, or hot-word expressions.';
    }
    if (enableEmojis) {
      extraInstructions += `\n- EMOJI TAGGING: Include 1 contextually relevant emoji attached to key emotive words, sudden expressions, or main nouns (e.g., "madbeka? 🚕", "Aiyo! 😱", "Love ❤️"). NEVER add emojis to routine narrative filler words like "and", "the", "is".`;
    }

    const systemPrompt = `You are an ultra-precise audio transcription, translation, and auto-speedup subtitle engine.

Your primary objective is ZERO-LAG LIP SYNC and SEMANTIC HOT-WORD ISOLATION.

=== 1. SPEECH DURATION & ACOUSTIC TIMING LOCK ===
- Detect exact acoustic start (\`start\`) and acoustic end (\`end\`) in milliseconds for each spoken word.
- Target Script: ${targetScriptInstruction}
- EXTENDED VOWELS & CADENCE: If the speaker elongates a word (e.g., "sooooo", "ammaaaa"), stretch the duration to cover the full physical sound length.
- PAUSES & BREATH BREAKS: Preserve natural silence gaps and pauses between phrases.

=== 2. SEMANTIC BREAKING & HOT-WORD TAGGING ===
- \`is_question\`: Mark TRUE for interrogatives or query words (e.g., "madbeka?", "can i book?", "Hassan?").
- \`is_sentence_end\`: Mark TRUE when a word ends with a full stop (\`.\`), exclamation (\`!\`), or question mark (\`?\`).${extraInstructions}

Return ONLY a valid JSON array of objects with keys:
"word" (string), "start" (integer ms), "end" (integer ms), "highlight" (boolean), "is_expression" (boolean), "is_question" (boolean), "is_sentence_end" (boolean), "is_name" (boolean).`;

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
              highlight: { type: "BOOLEAN" },
              is_expression: { type: "BOOLEAN" },
              is_question: { type: "BOOLEAN" },
              is_sentence_end: { type: "BOOLEAN" },
              is_name: { type: "BOOLEAN" }
            },
            required: ["word", "start", "end"]
          }
        }
      }
    };

    // Parallel Dispatch Strategy: Execute Deepgram and Gemini requests concurrently over Cloudflare fiber!
    const geminiKeys = geminiKeysRaw.split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
    const shuffledKeys = [...geminiKeys].sort(() => Math.random() - 0.5);

    const geminiPromise = (async () => {
      let lastErr = null;
      for (let i = 0; i < shuffledKeys.length; i++) {
        const currentKey = shuffledKeys[i];
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${currentKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiReqBody)
          });
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Gemini API Error (${res.status}): ${errText}`);
          }
          const data = await res.json();
          const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!candidateText) throw new Error('No valid response generated by Gemini.');
          return JSON.parse(candidateText);
        } catch (err) {
          lastErr = err;
        }
      }
      throw new Error(`All ${shuffledKeys.length} Gemini keys failed: ${lastErr ? lastErr.message : 'Unknown error'}`);
    })();

    // Await both Deepgram and Gemini in parallel!
    const [dgResult, rawGeminiResult] = await Promise.all([dgPromise, geminiPromise]);

    const dgWords = dgResult.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    const roughWords = dgWords.map(w => ({
      word: w.punctuated_word || w.word,
      start: Math.round(w.start * 1000),
      end: Math.round(w.end * 1000)
    }));

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
