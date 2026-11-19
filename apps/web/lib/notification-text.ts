// The inbox's texts are written by the API, once, for every channel (inbox, push, e-mail, chat). A few of them carry
// values as the API knows them: an operation's code name ("power_on"), an error code, a ticket priority ("high"), an
// amount as "120.00 TRY". The panel knows how to say each of those in the reader's language, and does so here for
// what it shows. Texts it does not recognise are shown as they came. Plain data in, plain data out.
export type NotificationText = { title: string; body: string };
export type Say = {
  operation: (kind: string) => string | null;   // "power_on" → "Power on"; null when unknown
  failure: (code: string) => string | null;     // "TIMEOUT" → its sentence; null when unknown
  priority: (value: string) => string | null;   // "high" → "High"
  money: (amount: number, currency: string) => string;
  operationDone: (name: string, operation: string) => string;
  operationFailed: (operation: string, reason: string) => string;
};

const amount = /(?<![\w.,])(\d+(?:\.\d{1,4})?) (TRY|EUR|USD|GBP)(?!\w)/g;
// "120.00 TRY" → the amount as the panel writes money everywhere else.
const withMoney = (text: string, say: Say) => text.replace(amount, (_, n: string, c: string) => say.money(Number(n), c));

export function readableNotification(event: string, n: NotificationText, say: Say): NotificationText {
  let { title, body } = n;
  if (event === 'server.power') {
    // "<name>: <kind> done" / "<name>: <kind> tamamlandı"
    const m = /^(.*): ([a-z][a-z_]*) (?:done|tamamlandı)$/.exec(title);
    const operation = m && say.operation(m[2]);
    if (m && operation) title = say.operationDone(m[1], operation);
  } else if (event === 'server.failed') {
    // "The <kind> operation could not finish (<CODE>)." / "<kind> işlemi tamamlanamadı (<CODE>)."
    const m = /^(?:The )?([a-z][a-z_]*) (?:operation could not finish|işlemi tamamlanamadı) \(([A-Z][A-Z0-9_]*)\)\.$/.exec(body);
    const operation = m && say.operation(m[1]);
    if (m && operation) body = say.operationFailed(operation, say.failure(m[2]) ?? m[2]);
  } else if (event === 'admin.operation_failed') {
    // "<kind> · <CODE> · <owner>": staff keep the code, the operation is named.
    const m = /^([a-z][a-z_]*) · /.exec(body);
    const operation = m && say.operation(m[1]);
    if (m && operation) body = operation + body.slice(m[1].length);
  } else if (event.startsWith('support.')) {
    // "<subject> · <e-mail> · <priority>"
    const m = / · (low|normal|high|urgent)$/.exec(body);
    const priority = m && say.priority(m[1]);
    if (m && priority) body = `${body.slice(0, m.index)} · ${priority}`;
  }
  return { title: withMoney(title, say), body: withMoney(body, say) };
}
