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

    // Optional Pre-Staged Payload (0s upload & 0s Deepgram on click!)
    let roughWordsRaw = formData.get('roughWords');
    let base64Audio = formData.get('base64Audio');
    let mimeType = formData.get('mimeType') || 'audio/wav';
    let dgResult = null;
    let roughWords = null;

    if (!geminiKeysRaw) {
      return new Response(JSON.stringify({ error: 'Missing Gemini API key.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (roughWordsRaw && base64Audio) {
      // Pre-staged mode: 0s Upload, 0s Deepgram!
      roughWords = JSON.parse(roughWordsRaw);
    } else {
      // Standard mode
      if (!file || !deepgramKey) {
        return new Response(JSON.stringify({ error: 'Missing required parameters (file or Deepgram key).' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const arrayBuffer = await file.arrayBuffer();
      mimeType = file.type || 'audio/wav';

      // 1. Pass 1: Enhanced Deepgram Nova-3 API Call
      let dgUrl = `https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=true&word_timestamps=true&filler_words=true`;
      if (spokenLang) {
        dgUrl += `&language=${encodeURIComponent(spokenLang)}`;
      }

      const authHeader = deepgramKey.toLowerCase().startsWith('token ') ? deepgramKey : `Token ${deepgramKey}`;
      const dgRes = await fetch(dgUrl, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': mimeType
        },
        body: arrayBuffer
      });

      if (!dgRes.ok) {
        const text = await dgRes.text();
        throw new Error(`Deepgram API error (${dgRes.status}): ${text}`);
      }

      dgResult = await dgRes.json();
      const dgWords = dgResult.results?.channels?.[0]?.alternatives?.[0]?.words || [];
      roughWords = dgWords.map(w => ({
        word: w.punctuated_word || w.word,
        start: Math.round(w.start * 1000),
        end: Math.round(w.end * 1000)
      }));

      // Convert ArrayBuffer to Base64 in RAM
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const len = bytes.byteLength;
      const chunkSize = 0x8000;
      for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      base64Audio = btoa(binary);
    }

    // 2. Prepare Enhanced Gemini Acoustic Alignment & Syllable Cadence Prompt
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

    const systemPrompt = `You are an expert speech-to-text acoustic alignment engine and millisecond pronunciation timer.

INPUT DATA:
1. Audio file.
2. Pass 1 baseline word timestamps: ${JSON.stringify(roughWords)}

STRICT ACOUSTIC PRONUNCIATION & MILLISECOND TIMING DIRECTIVES:
1. Target Script: ${targetScriptInstruction}
2. ACOUSTIC SOUND BOUNDS: Align each word's "start" and "end" timestamps directly to when the speaker's vocal organs actually produce the sound:
   - "start": Millisecond when the first vocal phoneme of the word is uttered.
   - "end": Millisecond when the vocal sound of that word ends.
3. EXTENDED VOWELS & CADENCE: If the speaker elongates or draws out a word (e.g., "sooooo", "ammaaaa"), stretch the (end - start) duration to cover the full physical sound length.
4. PAUSES & BREATH BREAKS: Preserve natural silence gaps and pauses between phrases. Do not stretch words over silent gaps.
5. Correct wrong/misspelled words from Pass 1 while keeping timestamps tightly bound to vocal sound onset/offset.${extraInstructions}

Return ONLY a valid JSON array of objects with keys "word" (string), "start" (integer ms), "end" (integer ms), and "highlight" (boolean).`;

    const geminiReqBody = {
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Audio
            }
          },
          { text: systemPrompt }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
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

    // Fast Failover Execution over Gemini Keys
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
