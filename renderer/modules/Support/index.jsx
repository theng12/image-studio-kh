import { Button } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';

// NOWPayments hosted donation page for Image Studio KH. The URL is public
// (it's the donor-facing page on NOWPayments) so it's safe to commit.
const NOWPAYMENTS_DONATION_URL = 'https://nowpayments.io/donation/studiokh';

const nowpaymentsConfigured =
  !!NOWPAYMENTS_DONATION_URL && !NOWPAYMENTS_DONATION_URL.includes('TODO_');

const APP_NAME = 'Image Studio KH';

export function Support() {
  function openDonate() {
    if (!nowpaymentsConfigured) return;
    // Routed through the main process's allow-listed external opener so the
    // URL lands in the user's default browser (where their crypto wallet
    // extension lives), not an Electron child window.
    window.api?.app.openExternal(NOWPAYMENTS_DONATION_URL).catch(() => {});
  }

  return (
    <div className="page page--support">
      <PageHeader title="Support this app" />

      <div className="support-stack">
        <section className="support-card">
          <h2 className="support-card__headline">
            <SupportHeartIcon />
            <span>{APP_NAME} is free, with all features unlocked.</span>
          </h2>
          <p className="support-card__body">
            If it saves you hours each week, you can support development with a one-time
            donation. Donations keep the app maintained, the bugs fixed, and the bundled
            fonts updated. Thank you.
          </p>
        </section>

        <section className="support-card">
          <div className="support-card__title-row">
            <h3 className="support-card__title">Donate</h3>
          </div>

          {nowpaymentsConfigured ? (
            <>
              <Button variant="primary" onClick={openDonate} className="support-card__cta">
                Pay with crypto (NOWPayments)
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden style={{ marginLeft: 6 }}>
                  <path d="M4 8 L8 4 M5 4 L8 4 L8 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Button>
              <p className="support-card__sub">
                Donate in any of 200+ coins via NOWPayments — handles conversion, no account
                needed on your end. Opens in your default browser.
              </p>
            </>
          ) : (
            <div className="support-card__pending">
              Donations are being set up. The next app update will include a payment widget
              here. Thanks for your patience.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SupportHeartIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden
      style={{ flex: '0 0 auto' }}
    >
      <path
        d="M9 15.5S2.5 12 2.5 7C2.5 4.6 4.4 2.7 6.8 2.7c1.3 0 2.5.6 3.2 1.7C10.7 3.3 11.9 2.7 13.2 2.7 15.6 2.7 17.5 4.6 17.5 7c0 5-6.5 8.5-6.5 8.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        transform="translate(-1, 0)"
      />
    </svg>
  );
}
