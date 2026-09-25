const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function renderTransactional(kind: 'confirm' | 'manage', link: string) {
  const confirm = kind === 'confirm';
  const subject = confirm ? 'Confirm your observing alerts' : 'Manage your observing alerts';
  const heading = confirm ? 'A clear night, in your inbox.' : 'Make the evening yours.';
  const intro = confirm
    ? 'Confirm your email to receive an observing plan when the forecast meets your preferences.'
    : 'Choose where, when and how you want to explore the night sky.';
  const button = confirm ? 'Confirm observing alerts' : 'Manage my alerts';
  const detail = confirm
    ? 'Your evening plan brings together the best observing window, hourly conditions and objects to look for with your equipment.'
    : 'Update your location, equipment and observing schedule, or pause your alerts whenever you like.';
  const footer =
    'This private link expires in 24 hours. If you did not request it, you can ignore this email.';
  return {
    subject,
    text: [subject, heading, intro, detail, button + ': ' + link, footer].join('\n\n'),
    html:
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#14151e;color:#f2f0e9;font:16px Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14151e"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px"><tr><td style="padding:32px 20px;line-height:1.65"><p style="color:#ebd785;font-size:13px;letter-spacing:2px">✦ STARWATCHR</p><h1 style="font-size:32px;line-height:1.2;margin:32px 0 20px">' +
      heading +
      '</h1><p>' +
      intro +
      '</p><p style="color:#c2c2ce">' +
      detail +
      '</p><p style="margin:28px 0"><a href="' +
      escape(link) +
      '" style="display:inline-block;padding:14px 20px;border-radius:8px;background:#ebd785;color:#1b1b24;font-weight:bold;text-decoration:none">' +
      button +
      '</a></p><p style="border-top:1px solid #343747;padding-top:20px;color:#c2c2ce;font-size:13px">' +
      footer +
      '</p></td></tr></table></td></tr></table></body></html>',
  };
}
