// Secret and PII redaction. Applied to every Analyzer7 write and used by the
// state validator to reject leaked credentials. Patterns are deliberately
// specific so metric names and env-var *names* survive.

const PLACEHOLDER_VALUE = /^(null|none|unknown|true|false|\[?redacted[^\s]*|<[^>]*>|\$\{?[A-Z_][A-Z0-9_]*\}?|env:[A-Z_][A-Z0-9_]*)$/i;

const TOKEN_PATTERNS = [
  {name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g},
  {name: 'stripe_key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g},
  {name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g},
  {name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g},
  {name: 'google_oauth_token', pattern: /\bya29\.[0-9A-Za-z_-]{20,}\b/g},
  {name: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g},
  {name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g},
  {name: 'anthropic_or_openai_key', pattern: /\bsk-(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}/g},
  {name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g},
  {name: 'bearer_token', pattern: /\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/-]*[0-9+/=])[A-Za-z0-9._~+/-]{12,}=*/g, replace: (_, scheme) => `${scheme} [REDACTED]`},
  {name: 'url_credential', pattern: /([?&](?:access_token|token|api_key|apikey|key|sig|signature|password|secret)=)(?!\[REDACTED)[^&\s"'<>)]+/gi, replace: (_, prefix) => `${prefix}[REDACTED]`},
  {name: 'url_userinfo', pattern: /(https?:\/\/)[^\s/:@"',]+:[^\s/@"',]+@/g, replace: (_, scheme) => `${scheme}[REDACTED]@`},
  {name: 'api_key_header', pattern: /\b((?:x[-_])?api[-_ ]key)(\s*[:=]?\s*)(?=[A-Za-z0-9_-]*\d)([A-Za-z0-9_-]{16,})/gi, replace: (_, key, separator) => `${key}${separator}[REDACTED]`},
];

// `key: value`, `key=value`, and JSON `"key": "value"` for secret-bearing keys.
const KEY_VALUE = /(["']?)\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|password|passwd|private[_-]?key|session[_-]?id|cookie|set-cookie|authorization))\b\1(\s*[:=]\s*)(["']?)([^\s"',}]+)\4/gi;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EMAIL_ALLOW = /^(noreply@anthropic\.com|[^@]+@example\.(com|org|net|test))$/i;
// Asset names like hero@2x.png look like addresses; they are not personal data.
const NOT_EMAIL = /\.(png|jpe?g|gif|webp|svg|avif|ico|css|js|pdf|mp4|webm|woff2?)$/i;

export function redact(input, {emails = true} = {}) {
  let text = String(input);
  let count = 0;
  for (const {pattern, replace} of TOKEN_PATTERNS) {
    text = text.replace(pattern, (...match) => {
      count += 1;
      return replace ? replace(...match) : '[REDACTED]';
    });
  }
  text = text.replace(KEY_VALUE, (whole, quote, key, separator, valueQuote, value) => {
    if (PLACEHOLDER_VALUE.test(value) || value.length < 8) return whole;
    count += 1;
    return `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
  });
  if (emails) {
    text = text.replace(EMAIL, (address) => {
      if (EMAIL_ALLOW.test(address) || NOT_EMAIL.test(address)) return address;
      count += 1;
      return '[REDACTED_EMAIL]';
    });
  }
  return {text, count};
}

// Returns the names of secret patterns present in text (used by validation).
export function findSecrets(input) {
  const text = String(input);
  const found = [];
  for (const {name, pattern} of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.push(name);
    pattern.lastIndex = 0;
  }
  KEY_VALUE.lastIndex = 0;
  for (const match of text.matchAll(KEY_VALUE)) {
    if (!PLACEHOLDER_VALUE.test(match[5]) && match[5].length >= 8) found.push(`key_value:${match[2].toLowerCase()}`);
  }
  for (const match of text.matchAll(EMAIL)) {
    if (!EMAIL_ALLOW.test(match[0]) && !NOT_EMAIL.test(match[0])) found.push('email');
  }
  return [...new Set(found)];
}
