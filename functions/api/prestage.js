export async function onRequestPost(context) {
  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    const deepgramKey = formData.get('deepgramApiKey');
    const spokenLang = formData.get('spokenLang') || 'en';

    if (!file || !deepgramKey) {
      return new Response(JSON.stringify({ error: 'Missing required parameters (file or Deepgram key).' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const arrayBuffer = await file.arrayBuffer();

    // Pass 1: High-Precision Deepgram Nova-3 Background Pre-Stage
    let dgUrl = `https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=true&word_timestamps=true&filler_words=true`;
    if (spokenLang) {
      dgUrl += `&language=${encodeURIComponent(spokenLang)}`;
    }

    const authHeader = deepgramKey.toLowerCase().startsWith('token ') ? deepgramKey : `Token ${deepgramKey}`;
    const dgRes = await fetch(dgUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': file.type || 'audio/wav'
      },
      body: arrayBuffer
    });

    if (!dgRes.ok) {
      const text = await dgRes.text();
      throw new Error(`Deepgram API error (${dgRes.status}): ${text}`);
    }

    const dgResult = await dgRes.json();
    const dgWords = dgResult.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    const roughWords = dgWords.map(w => ({
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
    const base64Audio = btoa(binary);

    return new Response(JSON.stringify({
      dgResult,
      roughWords,
      base64Audio,
      mimeType: file.type || 'audio/wav'
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
