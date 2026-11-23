export type CrmOtpPurpose = 'login' | 'email_current' | 'email_new';

const content: Record<CrmOtpPurpose, { subject: string; title: string; introduction: string; preheader: string }> = {
  login: {
    subject: 'Mã xác thực đăng nhập CRM',
    title: 'Xác thực đăng nhập',
    introduction: 'Để hoàn tất đăng nhập vào Bàn biên tập, nhập mã dưới đây tại màn hình xác thực CRM.',
    preheader: 'Hoàn tất đăng nhập vào Bàn biên tập bằng mã xác thực dùng một lần.',
  },
  email_current: {
    subject: 'Xác nhận thay đổi email tài khoản CRM',
    title: 'Xác nhận thay đổi email',
    introduction: 'Bạn đang thay đổi email nhận OTP của tài khoản CRM. Nhập mã dưới đây vào ô “Mã OTP email hiện tại” để xác nhận yêu cầu.',
    preheader: 'Xác nhận yêu cầu thay đổi email nhận mã xác thực của tài khoản CRM.',
  },
  email_new: {
    subject: 'Xác minh email tài khoản CRM',
    title: 'Xác minh email của bạn',
    introduction: 'Nhập mã dưới đây vào ô “Mã OTP email mới” trên CRM để xác minh địa chỉ email này và dùng làm email nhận mã xác thực.',
    preheader: 'Xác minh địa chỉ email nhận mã xác thực cho tài khoản Bàn biên tập.',
  },
};

export function isCrmOtpPurpose(purpose: unknown): purpose is CrmOtpPurpose {
  return typeof purpose === 'string' && Object.hasOwn(content, purpose);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Self-contained email: no remote images, fonts, links, or tracking requests. */
export function renderCrmOtpEmail(message: { code: string; purpose: CrmOtpPurpose }): { subject: string; text: string; html: string } {
  if (!/^\d{8}$/.test(message.code) || !isCrmOtpPurpose(message.purpose)) throw new TypeError('Invalid CRM OTP template input');
  const copy = content[message.purpose];
  const lifetime = 'Mã chỉ có hiệu lực trong thời gian còn lại hiển thị trên CRM (tối đa 10 phút) và chỉ được dùng một lần.';
  const security = 'Không chia sẻ mã OTP với bất kỳ ai, kể cả người tự xưng là nhân viên hỗ trợ.';
  const unexpected = 'Nếu bạn không yêu cầu thao tác này, hãy bỏ qua email và kiểm tra bảo mật tài khoản.';
  const text = [
    'Bàn biên tập', copy.title, copy.introduction, `Mã OTP của bạn: ${message.code}`,
    lifetime, security, unexpected, 'Email được gửi tự động từ hệ thống CRM.',
  ].join('\n\n');

  // Inline styles and presentation tables provide a usable fallback when an
  // email client strips the mobile stylesheet or does not support rounded corners.
  const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(copy.subject)}</title>
  <style>
    body, table, td, p, h1 { margin: 0; padding: 0; }
    table { border-collapse: collapse; }
    @media only screen and (max-width: 480px) {
      .email-canvas { padding: 24px 12px !important; }
      .email-content { padding: 28px 20px !important; }
      .email-title { font-size: 26px !important; line-height: 34px !important; }
      .otp-code { font-size: 32px !important; line-height: 44px !important; }
      .brand-name { font-size: 20px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; width: 100%; background-color: #f7f7f2; color: #202820; font-family: Arial, Helvetica, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
  <div style="display: none; font-size: 1px; line-height: 1px; color: #f7f7f2; max-height: 0; max-width: 0; opacity: 0; overflow: hidden; mso-hide: all;">${escapeHtml(copy.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f7f2" style="width: 100%; background-color: #f7f7f2;">
    <tr>
      <td class="email-canvas" align="center" style="padding: 40px 12px;">
        <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 560px;">
          <tr>
            <td style="padding: 0 4px 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="36" height="36" align="center" valign="middle" bgcolor="#efb84d" aria-hidden="true" style="width: 36px; height: 36px; background-color: #efb84d; border-radius: 8px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                      <td width="4" height="12" bgcolor="#202820" style="width: 4px; height: 12px; background-color: #202820; font-size: 0; line-height: 0;">&nbsp;</td>
                      <td width="3" style="width: 3px; font-size: 0; line-height: 0;">&nbsp;</td>
                      <td width="4" height="18" bgcolor="#202820" style="width: 4px; height: 18px; background-color: #202820; font-size: 0; line-height: 0;">&nbsp;</td>
                      <td width="3" style="width: 3px; font-size: 0; line-height: 0;">&nbsp;</td>
                      <td width="4" height="12" bgcolor="#202820" style="width: 4px; height: 12px; background-color: #202820; font-size: 0; line-height: 0;">&nbsp;</td>
                    </tr></table>
                  </td>
                  <td class="brand-name" style="padding-left: 12px; color: #202820; font-size: 22px; line-height: 30px; font-weight: 700; letter-spacing: -0.6px;">Bàn biên tập</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td bgcolor="#ffffff" style="background-color: #ffffff; border: 1px solid #e1e3da; border-top: 4px solid #2b5845; border-radius: 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%;">
                <tr>
                  <td class="email-content" style="padding: 36px 32px;">
                    <p style="margin: 0 0 12px; color: #2b5845; font-size: 11px; line-height: 18px; font-weight: 700; letter-spacing: 1.5px;">BẢO MẬT TÀI KHOẢN</p>
                    <h1 class="email-title" style="margin: 0 0 16px; color: #202820; font-size: 30px; line-height: 39px; font-weight: 700; letter-spacing: -0.8px;">${escapeHtml(copy.title)}</h1>
                    <p style="margin: 0 0 28px; color: #5f695f; font-size: 15px; line-height: 25px;">${escapeHtml(copy.introduction)}</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f5ef" style="width: 100%; background-color: #f1f5ef; border: 1px solid #dce5d8; border-radius: 8px;">
                      <tr>
                        <td align="center" style="padding: 22px 16px 20px;">
                          <p style="margin: 0 0 10px; color: #4c6452; font-size: 11px; line-height: 18px; font-weight: 700; letter-spacing: 1px;">MÃ XÁC THỰC CỦA BẠN</p>
                          <p class="otp-code" dir="ltr" style="margin: 0 0 10px; color: #244c39; font-family: 'Courier New', Courier, monospace; font-size: 36px; line-height: 48px; font-weight: 700; letter-spacing: 3px; white-space: nowrap;">${escapeHtml(message.code)}</p>
                          <p style="margin: 0; color: #5f695f; font-size: 12px; line-height: 20px;">Tối đa 10 phút &middot; Chỉ dùng một lần</p>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 14px 0 28px; color: #5f695f; font-size: 13px; line-height: 21px;">${escapeHtml(lifetime)}</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%;">
                      <tr>
                        <td style="padding: 2px 0 2px 16px; border-left: 3px solid #efb84d;">
                          <p style="margin: 0 0 5px; color: #202820; font-size: 14px; line-height: 22px; font-weight: 700;">Giữ mã này cho riêng bạn</p>
                          <p style="margin: 0; color: #5f695f; font-size: 13px; line-height: 21px;">${escapeHtml(security)}</p>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 24px 0 0; padding-top: 22px; border-top: 1px solid #e1e3da; color: #5f695f; font-size: 13px; line-height: 21px;">${escapeHtml(unexpected)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 22px 20px 0;">
              <p style="margin: 0 0 4px; color: #5f695f; font-size: 12px; line-height: 20px; font-weight: 700;">Bàn biên tập &middot; CRM</p>
              <p style="margin: 0; color: #6e746b; font-size: 12px; line-height: 20px;">Email được gửi tự động từ hệ thống CRM.</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject: copy.subject, text, html };
}
