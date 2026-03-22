function processFirefliesEmails() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TODOIST_API_TOKEN');
  if (!token) throw new Error("Todoist API token not found. Run setTodoistToken() first.");

  const personName = props.getProperty('FIREFLIES_PERSON_NAME');
  if (!personName) throw new Error("Fireflies person name not set. Run setFirefliesPersonName() first.");

  const routingRules = JSON.parse(props.getProperty('FIREFLIES_ROUTING') || '[]');

  const label = props.getProperty('FIREFLIES_GMAIL_LABEL') || 'Fireflies';
  const threads = GmailApp.search(`label:${label} is:unread`);

  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      if (!msg.isUnread()) return;
      const domain = getRecipientDomain(msg);
      const rule = routingRules.find(r => domain && domain.endsWith(r.domain)) || null;
      processFirefliesMessage(msg, personName, token, rule);
      msg.markRead();
    });
  });
}

function processFirefliesMessage(msg, personName, token, rule) {
  const htmlBody = msg.getBody();
  const subject = msg.getSubject();
  const messageId = msg.getId();

  const meetingTitle = subject.replace(/^Your meeting recap\s*[-–]\s*/i, '').trim();
  const gmailLink = `https://mail.google.com/mail/u/0/?shva=1#inbox/${messageId}`;
  const firefliesLink = extractFirefliesLink(htmlBody);
  const actionItems = parseFirefliesActionItems(htmlBody, personName);

  if (actionItems.length === 0) {
    console.log(`No action items found for "${personName}" in: ${meetingTitle}`);
    return;
  }

  // Resolve project and section once per message
  let projectId = null;
  let sectionId = null;
  if (rule && rule.project) {
    projectId = getTodoistProjectId(token, rule.project);
    if (rule.section) {
      sectionId = getOrCreateTodoistSection(token, projectId, rule.section);
    }
  }

  actionItems.forEach(item => {
    const timestampMatch = item.match(/\((\d+:\d+(?::\d+)?)\)\s*$/);
    const timestamp = timestampMatch ? timestampMatch[1] : null;
    const content = item.replace(/\s*\(\d+:\d+(?::\d+)?\)\s*$/, '').trim();

    const descLines = [`Meeting: ${meetingTitle}`];
    if (firefliesLink) descLines.push(`[View in Fireflies](${firefliesLink})`);
    descLines.push(`[View Gmail message](${gmailLink})`);
    if (timestamp) descLines.push(`Timestamp: ${timestamp}`);

    const payload = { content, description: descLines.join('\n') };
    if (projectId) payload.project_id = projectId;
    if (sectionId) payload.section_id = sectionId;

    const response = UrlFetchApp.fetch('https://api.todoist.com/api/v1/tasks', {
      method: 'POST',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${token}` },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      console.log('Error response:', response.getContentText());
      throw new Error(`Todoist API failed (${response.getResponseCode()}): ${response.getContentText()}`);
    }

    console.log(`Created task: ${content}${projectId ? ` (project: ${rule.project})` : ''}`);
  });
}

// Returns the domain portion of the To address (e.g. "gr-oss.io").
// Note: if email is auto-forwarded, the To header may show the forwarding address.
// In that case, set up separate Gmail labels per account instead of relying on domain.
function getRecipientDomain(msg) {
  const to = msg.getTo() || '';
  const match = to.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : null;
}

function getTodoistProjectId(token, projectName) {
  const response = UrlFetchApp.fetch('https://api.todoist.com/api/v1/projects', {
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error(`Failed to fetch Todoist projects: ${response.getContentText()}`);
  }
  const data = JSON.parse(response.getContentText());
  const projects = Array.isArray(data) ? data : (data.results || []);
  const project = projects.find(p => p.name === projectName);
  if (!project) throw new Error(`Todoist project "${projectName}" not found`);
  return project.id;
}

function getOrCreateTodoistSection(token, projectId, sectionName) {
  const listResp = UrlFetchApp.fetch(
    `https://api.todoist.com/api/v1/sections?project_id=${projectId}`,
    { headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true }
  );
  if (listResp.getResponseCode() !== 200) {
    throw new Error(`Failed to fetch sections: ${listResp.getContentText()}`);
  }
  const sectionsData = JSON.parse(listResp.getContentText());
  const sections = Array.isArray(sectionsData) ? sectionsData : (sectionsData.results || []);
  const existing = sections.find(s => s.name === sectionName);
  if (existing) return existing.id;

  const createResp = UrlFetchApp.fetch('https://api.todoist.com/api/v1/sections', {
    method: 'POST',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ project_id: projectId, name: sectionName }),
    muteHttpExceptions: true
  });
  if (createResp.getResponseCode() !== 200) {
    throw new Error(`Failed to create section "${sectionName}": ${createResp.getContentText()}`);
  }
  console.log(`Created Todoist section: "${sectionName}"`);
  return JSON.parse(createResp.getContentText()).id;
}

function parseFirefliesActionItems(htmlBody, personName) {
  // Extract the section between "Action Items" and "View complete meeting notes"
  const sectionMatch = htmlBody.match(/Action Items([\s\S]*?)View complete meeting notes/i);
  if (!sectionMatch) return [];

  const section = sectionMatch[1];

  // Extract all <td> text content
  const tdMatches = section.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
  const texts = tdMatches.map(td => {
    return td
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }).filter(t => t.length > 0);

  // Person names do NOT end with (mm:ss) or (hh:mm:ss); action items DO
  const timestampRe = /\(\d+:\d+(?::\d+)?\)\s*$/;
  const items = [];
  let collecting = false;

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!timestampRe.test(text)) {
      collecting = text.toLowerCase().includes(personName.toLowerCase());
    } else if (collecting) {
      items.push(text);
    }
  }

  return items;
}

function extractFirefliesLink(htmlBody) {
  const match = htmlBody.match(/https:\/\/app\.fireflies\.ai\/view\/[a-zA-Z0-9_%-]+/);
  if (!match) return null;
  return match[0].split('?')[0];
}

function setFirefliesPersonName(name) {
  PropertiesService.getScriptProperties().setProperty('FIREFLIES_PERSON_NAME', name);
  console.log(`Fireflies person name set to: ${name}`);
}

// routingArray example:
// [
//   { "domain": "gr-oss.io", "project": "GR", "section": "Generated Tasks" },
//   { "domain": "insightsoftmax.com", "project": "ISC" }
// ]
function setFirefliesRouting(routingArray) {
  PropertiesService.getScriptProperties().setProperty(
    'FIREFLIES_ROUTING', JSON.stringify(routingArray)
  );
  console.log('Fireflies routing saved:');
  routingArray.forEach(r => {
    console.log(`  @${r.domain} → project "${r.project}"${r.section ? ` / section "${r.section}"` : ''}`);
  });
}

function setupFirefliesLabel() {
  const props = PropertiesService.getScriptProperties();
  const labelName = props.getProperty('FIREFLIES_GMAIL_LABEL') || 'Fireflies';

  try {
    GmailApp.createLabel(labelName);
    console.log(`Gmail label "${labelName}" created.`);
  } catch (e) {
    console.log(`Label "${labelName}" may already exist: ${e.message}`);
  }

  console.log('');
  console.log('Next step: create a Gmail filter manually:');
  console.log('  From: fred@fireflies.ai');
  console.log(`  Action: Apply label "${labelName}"`);
  console.log('  Gmail Settings → Filters and Blocked Addresses → Create new filter');
}

function createFirefliesTrigger() {
  ScriptApp.newTrigger('processFirefliesEmails')
    .timeBased()
    .everyMinutes(5)
    .create();
  console.log('Trigger created — processFirefliesEmails will run every 5 minutes.');
}
