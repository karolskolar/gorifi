/* Podpultovka Friends — UI primitives (theme 09 Neobrutal PP) */
const { useState: useUIState } = React;

const I = {
  back: (p) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" {...p}><path d="M15 18l-6-6 6-6"/></svg>,
  chev: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" {...p}><path d="M9 18l6-6-6-6"/></svg>,
  check: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" {...p}><path d="M20 6L9 17l-5-5"/></svg>,
  share: (p) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.7 10.7l6.6-3.4M8.7 13.3l6.6 3.4"/></svg>,
  gear: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  pencil: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>,
  logout: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>,
  close: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" {...p}><path d="M18 6L6 18M6 6l12 12"/></svg>,
  copy: (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  lock: (p) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>,
  cal: (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  invite: (p) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>,
  eye: (p) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  warn: (p) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>,
};

const BAG_COLORS = { "brazil-green": "#3f9142", "brazil-yellow": "#e8c33a", "colombia-red": "#c8362f", "colombia-blue": "#2f5bc8", "highlander": "#7b46b5", "jednoducho": "#d0642a", "milkyway": "#26407a", "peru-red": "#b83232", "ecuador": "#2fa5a0", "gobananas": "#e3c53a", "peach": "#e8843a" };
function ProductImg({ img, size = 64, label, stretch }) {
  const c = BAG_COLORS[img] || "#888";
  return (
    <div className="pimg" style={stretch ? { width: size, minHeight: size, height: "auto", alignSelf: "stretch" } : { width: size, height: size }}>
      <div className="cap"></div>
      <div className="band" style={{ background: c }}></div>
      <div className="lbl">{label || "GORIFFEE"}</div>
    </div>
  );
}

/* controlled stepper */
function Stepper({ value, onChange, disabled, min = 0 }) {
  return (
    <div className={"stepper" + (disabled ? " disabled" : "")}>
      <button aria-label="menej" onClick={() => onChange && onChange(Math.max(min, value - 1))}>−</button>
      <span className="val">{value}</span>
      <button aria-label="viac" onClick={() => onChange && onChange(value + 1)}>+</button>
    </div>
  );
}

function Checkbox({ checked, onChange, big, ok }) {
  return (
    <span className={"cbox" + (big ? " big" : "") + (ok ? " ok" : "") + (checked ? " on" : "")} onClick={() => onChange && onChange(!checked)}>
      <span style={{ color: "#fff", display: "flex" }}>{I.check()}</span>
    </span>
  );
}

function Money({ v }) {
  return <span className="mono" style={{ whiteSpace: "nowrap" }}>{v.toFixed(2)} EUR</span>;
}

function Ticker({ text }) {
  const seg = text || "+++ TOVAR POD PULTOM +++ IBA PRE STÁLYCH +++";
  return <div className="ticker"><span>{seg}&nbsp;&nbsp;{seg}&nbsp;&nbsp;{seg}</span></div>;
}
function BrandStrip({ tickerText }) {
  return <React.Fragment><div className="hazard"></div><Ticker text={tickerText} /></React.Fragment>;
}

/* ---------- modal (portals into the device-frame layer so it centers in the visible screen) ---------- */
const ModalLayerCtx = React.createContext(null);
function Modal({ title, subtitle, onClose, children, footer, wide }) {
  const layer = React.useContext(ModalLayerCtx);
  const body = (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className="modal" style={wide ? { maxWidth: 520 } : undefined}>
        <div className="m-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="m-title">{title}</div>
            {subtitle ? <div className="sub" style={{ marginTop: 4 }}>{subtitle}</div> : null}
          </div>
          {onClose ? <span className="m-x" onClick={onClose}>{I.close()}</span> : null}
        </div>
        <div className="m-body">{children}</div>
        {footer ? <div className="m-foot">{footer}</div> : null}
      </div>
    </div>
  );
  if (layer && layer.current) return ReactDOM.createPortal(body, layer.current);
  return body;
}

function Field({ label, help, children }) {
  return (
    <div>
      <label className="field-lbl">{label}</label>
      {children}
      {help ? <div className="field-help">{help}</div> : null}
    </div>
  );
}
function Input(props) {
  return <input className={"inp" + (props.mono ? " mono" : "")} {...props} />;
}

/* copy-to-clipboard row with "Skopírované!" feedback */
function CopyRow({ value, small }) {
  const [copied, setCopied] = useUIState(false);
  const copy = () => {
    try { navigator.clipboard.writeText(value); } catch (e) {}
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="copyrow">
      <div className="val" title={value}>{value}</div>
      <button className={"btn" + (small ? " sm" : "") + (copied ? " ok" : "")} onClick={copy}>{copied ? "Skopírované!" : "Kopírovať"}</button>
    </div>
  );
}

/* deterministic pseudo-QR placeholder (Pay by Square) */
function QRBox({ seed = 7 }) {
  const cells = [];
  const N = 17;
  const finder = (r, c) => (r < 5 && c < 5) || (r < 5 && c >= N - 5) || (r >= N - 5 && c < 5);
  const finderOn = (r, c) => {
    const lr = r >= N - 5 ? r - (N - 5) : r, lc = c >= N - 5 ? c - (N - 5) : c;
    return lr === 0 || lr === 4 || lc === 0 || lc === 4 || (lr === 2 && lc === 2);
  };
  let x = seed;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const on = finder(r, c) ? finderOn(r, c) : (x >> 16) % 5 < 2;
    cells.push(<i key={r + "-" + c} className={on ? "on" : ""}></i>);
  }
  return <div className="qr"><div className="grid">{cells}</div></div>;
}

/* Revolut pay button (guest + friend payment modal) */
function RevolutBtn() {
  return (
    <button className="btn block" style={{ background: "#0075EB", color: "#fff", borderColor: "#0a0a0a" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.1 6.8c-.3-1.2-1-2.2-2-2.9-.9-.7-2.1-1-3.3-1H6.2L4 20.1h4.1l1-5.5h3.7c1.6 0 3-.5 4.1-1.4 1.1-.9 1.9-2.2 2.2-3.8l.5-2.6zM16 9.2l-.2 1c-.2.9-.6 1.5-1.2 2-.6.5-1.4.7-2.3.7H9.1l1-5.5h3.2c.7 0 1.2.2 1.6.6.4.4.5.9.4 1.5l-.3 1.7z"/></svg>
      Zaplatiť cez Revolut
    </button>
  );
}

/* payment modal — shared by friend footer, guest confirmation and guest status */
function PaymentModal({ amount, reference, onClose }) {
  const D = window.FP_DATA;
  return (
    <Modal title="Platba" subtitle={<span>Suma na úhradu: <b className="mono">{amount.toFixed(2)} EUR</b></span>} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Zavrieť</button>}>
      <RevolutBtn />
      <div style={{ textAlign: "center" }}>
        <div className="sub" style={{ marginBottom: 10 }}>Pay by Square (QR kód pre bankovú appku)</div>
        <QRBox />
        <div className="sub mono" style={{ marginTop: 10, fontSize: 12 }}>IBAN: {D.payment.iban}</div>
      </div>
      {reference ? (
        <Field label="Poznámka k platbe (uveďte ju pri platbe)">
          <CopyRow value={reference} small />
        </Field>
      ) : null}
    </Modal>
  );
}

Object.assign(window, { I, ProductImg, Stepper, Checkbox, Money, Ticker, BrandStrip, Modal, ModalLayerCtx, Field, Input, CopyRow, QRBox, RevolutBtn, PaymentModal });

/* center the tapped category tab in its scroll strip (mobile) */
window.snapTab = function (e) {
  const el = e.currentTarget, p = el.parentNode;
  p.scrollTo({ left: Math.max(0, el.offsetLeft - (p.clientWidth - el.offsetWidth) / 2), behavior: "smooth" });
};
