/** JSON embedded in HTML script text must not contain a literal `<`.
 * JSON escapes preserve the data while preventing closing tags and comment states.
 * Keep normal JSON.stringify behavior, including omitted undefined properties.
 */
function jsonForHtml(value) {
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json.replace(/</g, '\\u003c') : json;
}

module.exports = { jsonForHtml };
