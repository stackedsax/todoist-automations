function createTaskFromStarred() {
  const todoistToken = PropertiesService.getScriptProperties().getProperty('TODOIST_API_TOKEN');
  if (!todoistToken) throw new Error("Todoist API token not found. Run setTodoistToken() first.");

  const threads = GmailApp.search('is:starred');

  threads.forEach(thread => {
    const messages = thread.getMessages();
    if (!messages || messages.length === 0) return;

    messages.forEach(message => {
      if (!message || !message.isStarred()) return;

      const subject = message.getSubject();
      const messageId = message.getId();
      const link = `https://mail.google.com/mail/u/0/?shva=1#inbox/${messageId}`;

      const rawBody = extractCleanBodySimple(message);
      const bodyText = cleanEmailBody(rawBody);

      const payload = {
        content: subject + ' @starred',
        description: `[View original email](${link})\n\n${bodyText}`
      };

      const response = UrlFetchApp.fetch('https://api.todoist.com/api/v1/tasks', {
        method: 'POST',
        contentType: 'application/json',
        headers: {
          Authorization: `Bearer ${todoistToken}`
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      if (response.getResponseCode() !== 200) {
        console.log('Error response:', response.getContentText());
        throw new Error(`API request failed with code ${response.getResponseCode()}: ${response.getContentText()}`);
      }

      message.unstar();
    });
  });
}

function createTrigger() {
  ScriptApp.newTrigger('createTaskFromStarred')
    .timeBased()
    .everyMinutes(1)
    .create();
  console.log('Trigger created successfully - will run every minute');
}

function extractCleanBodySimple(message) {
  if (!message || typeof message.getPlainBody !== 'function') return '';

  const plain = message.getPlainBody();
  if (plain && plain.trim().length > 20) return plain;

  let html = message.getBody();
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<\/?[^>]+(>|$)/g, '');  // strip tags
  return html.replace(/\s+/g, ' ').trim().slice(0, 3000);
}

function walkHtmlAndExtract(element) {
  const tag = element.getName().toLowerCase();
  const invisible = ['style', 'script', 'head', 'meta', 'noscript'];
  if (invisible.includes(tag)) return '';

  // Special case: link conversion
  if (tag === 'a' && element.getAttribute('href')) {
    const url = element.getAttribute('href').getValue();
    const text = extractTextContent(element);
    return `[${text}](${url})`;
  }

  // Aggregate text and recurse into children
  let text = '';
  if (element.getText()) text += element.getText();

  const children = element.getChildren();
  for (let i = 0; i < children.length; i++) {
    text += walkHtmlAndExtract(children[i]);
  }

  return text.replace(/\s+/g, ' ').trim() + ' ';
}

function extractTextContent(element) {
  let text = element.getText() || '';
  element.getChildren().forEach(child => {
    text += extractTextContent(child);
  });
  return text.trim();
}

function cleanEmailBody(bodyText) {
  // Remove long bare URLs (especially trackers)
  bodyText = bodyText.replace(/https?:\/\/[^\s]*?(list\.[^\s]+|actionnetwork\.org)[^\s)]+/gi, '');

  // Remove lines that include unsubscribe/update contact
  bodyText = bodyText.replace(/^.*(unsubscribe|update.*contact|privacy policy|stop receiving).*$/gim, '');

  // Optional: strip after first unsubscribe mention
  const cutIndex = bodyText.search(/(unsubscribe|stop receiving)/i);
  if (cutIndex > 0) bodyText = bodyText.slice(0, cutIndex);

  // Clean up spacing
  return bodyText.replace(/\n{3,}/g, '\n\n').trim();
}
