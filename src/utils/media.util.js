// Meta reports mime types like "audio/ogg; codecs=opus"; Gemini wants a bare
// supported type, so drop any parameters after ';'.
export function normalizeAudioMimeType(mimeType = 'audio/ogg') {
  return mimeType.split(';')[0].trim() || 'audio/ogg';
}
