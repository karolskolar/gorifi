/* Podpultovka Friends — Portál v2 (2026-09): landing = ponuka, menu, stavy kola, "Ako to funguje".
   Interactive: hamburger menu navigates between views, steppers mutate the cart, modals open.
   States (selector "Stav"): open · closed · locked · first (prvé prihlásenie → explainer first). */
const { useState: useP2, useMemo: useP2M } = React;

/* icons the v1 set lacks (same stroke style as ui.jsx → I) */
const I2 = {
  menu: (p) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" {...p}><path d="M3 6h18M3 12h18M3 18h18"/></svg>,
  bag: (p) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" {...p}><path d="M6 7h12l1 14H5z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/></svg>,
  list: (p) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>,
  wallet: (p) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M16 15h2"/></svg>,
  help: (p) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" {...p}><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01"/></svg>,
  user: (p) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  pin: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" {...p}><path d="M21 10c0 7-9 12-9 12S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  pause: (p) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" {...p}><circle cx="12" cy="12" r="10"/><path d="M10 9v6M14 9v6"/></svg>,
  bell: (p) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>,
  cup: (p) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" {...p}><path d="M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10h2a2 2 0 0 1 0 4h-2"/><path d="M8 3v2M11 3v2"/></svg>,
  truck: (p) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" {...p}><path d="M1 3h13v13H1z"/><path d="M14 8h5l3 3v5h-8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
  box: (p) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" {...p}><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>,
  hand: (p) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M8 13V5a2 2 0 0 1 4 0v6"/><path d="M12 11V4a2 2 0 0 1 4 0v7"/><path d="M16 11V6a2 2 0 0 1 4 0v8a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.3L3.5 14a2 2 0 0 1 3.3-2.2L8 13"/></svg>,
};

/* money: prototype convention "9.90 EUR" (production uses the repo's fmtEur: "9,90 €" on lines, "47,80 EUR" on totals) */
const eur = (v) => v.toFixed(2) + " EUR";
const eurT = eur;

/* demo data for the v2 states (the v1 FP_DATA stays untouched) */
const P2 = {
  cycle: { name: "Goriffee September 2026", short: "september 2026", closes: "piatku 12. 9.", closesDate: "12. 9. 2026", expected: "24. 9.", count: 14 },
  roasters: [["Goriffee", "Pražiareň — stály základ ponuky. Espresso aj filter, čerstvo pražené na objednávku."], ["Robo", "Domáci pražič. Hľadá zelenú kávu s vysokým hodnotením SCA (Specialty Coffee Association) a praží ju sám, v malých dávkach — všetko pod jeho značkou je ručne pražené doma."]],
  next: { date: "3. októbra", inWeeks: "o 4 týždne" },
  pickup: "Neškôlka · Karlova Ves",
  order: [["Brazil Morada da Prata Natural · 250 g", 2, 15.20], ["Burundi Gakenke Washed · 1 kg", 1, 37.60]],
  stages: [
    ["done", "Objednávky otvorené", "5. – 12. 9.", ""],
    ["done", "Objednávky uzavreté, káva objednaná v pražiarni", "12. 9.", ""],
    ["now", "Káva dorazila, balíme", "dnes, 23. 9.", "Balíčky pripravíme do 2 dní."],
    ["next", "Zabalené — na odbernom mieste", "≈ 25. 9.", "Dáme vedieť cez WhatsApp, keď bude v Neškôlke."],
    ["next", "Vyzdvihnuté", "", ""],
  ],
  tx: [
    ["23. 9. 2026", "Goriffee September 2026 — objednávka", -52.80],
    ["3. 8. 2026", "Platba (Revolut)", 44.15],
    ["1. 8. 2026", "Goriffee August 2026 — objednávka", -7.60],
    ["2. 7. 2026", "Goriffee Júl 2026 — objednávka", -13.09],
  ],
  pickupPoints: [["Lego doma", "Dúbravka"], ["Neškôlka", "Karlova Ves"], ["Kancelária BA", "Staré Mesto"]],
};

function Timeline({ steps }) {
  return (
    <div className="p2-tl">
      {steps.map(([state, lbl, when, desc], i) => (
        <div key={i} className={"st " + state}>
          <span className="mk">{state === "done" ? <span style={{ display: "flex", color: "#fff" }}>{I.check()}</span> : i + 1}</span>
          <div style={{ minWidth: 0 }}>
            <div className="lbl">{lbl}</div>
            {when ? <div className="when">{when}</div> : null}
            {desc ? <div className="desc">{desc}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Dots({ now = 0, n = 6 }) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(<span key={"d" + i} className={"d" + (i === now ? " now" : i > now ? " next" : "")}></span>);
    if (i < n - 1) items.push(<span key={"l" + i} className="ln"></span>);
  }
  return <div className="p2-dots">{items}</div>;
}

/* ---------- hamburger menu (drawer in the modal layer) ---------- */
function MenuDrawer({ view, onClose, go, balance, cartTotal, open }) {
  const D = window.FP_DATA;
  const layer = React.useContext(ModalLayerCtx);
  const Item = ({ k, icon, label, sub, trailing }) => (
    <div className={"p2-mi" + (view === k ? " on" : "")} onClick={() => go(k)}>
      <span className="ic">{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="lab">{label}</div>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {trailing !== undefined ? trailing : <span style={{ display: "flex", color: view === k ? "var(--accent-ink)" : "var(--accent)" }}>{I.chev()}</span>}
    </div>
  );
  const body = (
    <div className="p2-drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="p2-drawer">
        <div className="p2-dh">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="display" style={{ fontSize: 25, lineHeight: 1.1 }}>Pod<span style={{ color: "var(--accent)" }}>pult</span>ovka</div>
            <div style={{ marginTop: 8, fontWeight: 700, fontSize: 15 }}>{D.friend.name}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--nav-ink-dim)", marginTop: 2 }}>{D.friend.code} · člen od 2024</div>
          </div>
          <span className="p2-icobtn" style={{ margin: "-6px -6px 0 0" }} onClick={onClose}>{I.close()}</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          <Item k="shop" icon={I2.bag()} label="Aktuálna ponuka" sub={open ? `Otvorené do ${P2.cycle.closesDate}` + (cartTotal > 0 ? ` · v košíku ${eur(cartTotal)}` : "") : "Objednávky sú zatvorené"} />
          <Item k="history" icon={I2.list()} label="Moje objednávky" sub={`${D.archive.length + 1} objednávky · naposledy ${P2.cycle.short}`} />
          <Item k="balance" icon={I2.wallet()} label="Zostatok a platby"
            trailing={balance < 0 ? <span className="badge danger">{eur(balance)}</span> : <span className="badge ok">{eur(balance)}</span>} />
          {open && <Item k="share" icon={I.share()} label="Zdieľať s kolegami" sub="3 kolegovia · 4 kg cez váš odkaz" />}
          <Item k="invite" icon={I.invite()} label="Pozvať priateľa" sub="Váš pozývací odkaz" />
          <Item k="explainer" icon={I2.help()} label="Ako to funguje" />
          <Item k="profile" icon={I2.user()} label="Profil" sub="Meno, telefón, Packeta, heslo" />
        </div>
        <div style={{ padding: "14px 18px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, borderTop: "3px solid var(--nb-ink)" }}>
          <button className="btn ghost" style={{ paddingLeft: 0, gap: 8 }} onClick={() => go("logout")}>{I.logout()} Odhlásiť sa</button>
          <span className="sub mono" style={{ fontSize: 11 }}>podpultovka.biz</span>
        </div>
      </div>
    </div>
  );
  if (layer && layer.current) return ReactDOM.createPortal(body, layer.current);
  return body;
}

/* ---------- explainer ("Ako to funguje") ---------- */
function Explainer({ onDone, phone }) {
  const [hide, setHide] = useP2(false);
  const Step = ({ ic, n, title, text }) => (
    <div className="p2-step">
      <div className="ico">{ic}<span className="n">{n}</span></div>
      <div style={{ minWidth: 0, paddingTop: 2 }}>
        <div className="display" style={{ fontSize: 20, lineHeight: 1 }}>{title}</div>
        <div className="sub" style={{ fontSize: 14, lineHeight: 1.4, marginTop: 5 }}>{text}</div>
      </div>
    </div>
  );
  const Way = ({ ic, title, text, badge, badgeCls }) => (
    <div className="card flat" style={{ padding: "12px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span style={{ display: "flex", flexShrink: 0, paddingTop: 2 }}>{ic}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><b style={{ fontSize: 15 }}>{title}</b><span className={"badge " + badgeCls} style={{ marginLeft: "auto" }}>{badge}</span></div>
        <div className="sub" style={{ fontSize: 13.5, lineHeight: 1.4, marginTop: 3 }}>{text}</div>
      </div>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, paddingBottom: 12 }}>
      <h1 className="h-screen" style={{ fontSize: phone ? 40 : 52, lineHeight: 1.08, marginTop: 4 }}>Káva pod<br /><span className="p2-hl">pultom</span>, spolu.</h1>
      <p className="sub" style={{ fontSize: 15, lineHeight: 1.45, margin: 0 }}>Podpultovka je spoločná objednávka výberovej kávy pre okruh priateľov. Raz za pár týždňov otvoríme objednávky, nakúpime priamo v pražiarni za lepšiu cenu a rozdáme si to medzi sebou.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Step ic={I2.pause()} n={1} title="Pauza" text="Väčšinu času sa neobjednáva. Ponuku si môžete prezrieť, košík je zamknutý." />
        <Step ic={I2.bell()} n={2} title="Ohlásenie objednávky" text="Pár dní vopred sa dozviete, kedy sa objednávky otvoria. V appke aj cez WhatsApp." />
        <Step ic={I2.cup()} n={3} title="Objednávanie" text="Zvyčajne 5–7 dní. Naklikáte si kávu, odošlete, do uzamknutia môžete meniť." />
        <Step ic={I2.truck()} n={4} title="Čakáme na pražiareň" text="Objednávky uzavrieme, kávu objednáme. Praží sa na čerstvo, trvá to okolo týždňa." />
        <Step ic={I2.box()} n={5} title="Balíme" text="Káva dorazila, každému zabalíme jeho objednávku. Vtedy je čas zaplatiť." />
        <Step ic={I2.hand()} n={6} title="Odovzdanie" text="Vyzdvihnete si ju na odbernom mieste, od priateľa alebo príde Packetou." />
      </div>
      <div>
        <div className="field-lbl" style={{ marginBottom: 10 }}>Ako sa ku káve dostanete</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Way ic={I2.pin({ width: 20, height: 20 })} title="Odberné miesto v Bratislave" text={P2.pickupPoints.map(([n, a]) => `${n} (${a})`).join(" · ") + ". Vyberáte pri objednávke."} badge="zdarma" badgeCls="ok" />
          <Way ic={I.invite()} title="Cez priateľa" text="Objednávate cez odkaz od priateľa? Kávu prevezme on/ona a odovzdá vám ju." badge="zdarma" badgeCls="ok" />
          <Way ic={I2.truck({ width: 18, height: 18 })} title="Packeta" text="Nie ste z Bratislavy? Objednajte si a nechajte poslať cez Packetu — na ľubovoľný Z-BOX alebo výdajné miesto." badge={"+" + eur(window.FP_DATA.cycle.parcelFee)} badgeCls="acc-o" />
        </div>
      </div>
      <div>
        <div className="field-lbl" style={{ marginBottom: 10 }}>Kto sme a odkiaľ je káva</div>
        <div className="sub" style={{ fontSize: 14, lineHeight: 1.45, marginBottom: 10 }}>Podpultovka vznikla ako jedna objednávka pre pár kamarátov. Nie je to obchod — je to okruh známych a známych ich známych, len na pozvánku. Káva pochádza z dvoch zdrojov, podľa značky na karte produktu:</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {P2.roasters.map(([n, t]) => (
            <div key={n} className="card flat" style={{ padding: "12px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span className={"badge" + (n === "Robo" ? " acc-o" : "")} style={{ flexShrink: 0, marginTop: 1 }}>{n}</span>
              <div className="sub" style={{ fontSize: 13.5, lineHeight: 1.4 }}>{t}</div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="field-lbl" style={{ marginBottom: 10 }}>Ako platím</div>
        <div className="sub" style={{ fontSize: 14, lineHeight: 1.45 }}>Po zabalení dostanete sumu a QR kód. Zaplatíte jedným klepnutím cez <b>Revolut</b> alebo <b>bankovú appku</b> (PayMe), alebo prevodom na účet. Bez hotovosti.</div>
      </div>
      <div className="card flat" style={{ padding: 14, background: "var(--accent-soft)", display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div className="display" style={{ width: 44, height: 44, borderRadius: 12, border: "3px solid var(--nb-ink)", background: "var(--nb-ink)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 22 }}>K</div>
        <div style={{ fontSize: 14, lineHeight: 1.45 }}>„Podpultovku robím vo voľnom čase pre kamarátov a kamarátov kamarátov. Ak čokoľvek nesedí, napíšte mi na WhatsApp.“<br /><b>— Karol</b></div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, cursor: "pointer" }}><Checkbox checked={hide} onChange={setHide} /> Už mi to neukazovať</label>
        <button className="btn accent block" onClick={onDone}>Rozumiem, idem na ponuku</button>
      </div>
    </div>
  );
}

/* ---------- history + balance views ---------- */
function HistoryView({ phone }) {
  const D = window.FP_DATA;
  const [open, setOpen] = useP2(null);
  const total = P2.order.reduce((s, [, q, p]) => s + p, 0);
  const rounds = [
    { id: "cur", name: P2.cycle.name, date: P2.cycle.closesDate, total, status: "Balíme", cls: "acc", items: P2.order },
    ...D.archive.map((c) => ({ id: c.id, name: c.name, date: "", total: c.orderTotal, status: "Vyzdvihnuté", cls: "ok", items: [["1× " + (c.type === "bakery" ? "pečivo" : "káva"), 1, c.orderTotal]] })),
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 className="h-screen" style={{ fontSize: phone ? 28 : 34 }}>Moje <span className="hl">objednávky</span></h2>
      {rounds.map((r) => (
        <div key={r.id} className={"card" + (r.id === "cur" ? " hl" : " flat")} style={{ padding: 14, cursor: "pointer" }} onClick={() => setOpen(open === r.id ? null : r.id)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div className="display" style={{ fontSize: 20, lineHeight: 1 }}>{r.name}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}><span className={"badge " + r.cls}>{r.status}</span></div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span className="display" style={{ fontSize: 18 }}>{eurT(r.total)}</span>
              <span className={"chev" + (open === r.id ? " open" : "")}>{I.chev()}</span>
            </div>
          </div>
          {open === r.id && (
            <div className="p2-lines" style={{ marginTop: 12 }}>
              {r.items.map(([n, q, p], i) => <div key={i} className="ln"><span>{n} <span className="mono">×{q}</span></span><span className="mono">{eur(p)}</span></div>)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function BalanceView({ balance, onPay, phone }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 className="h-screen" style={{ fontSize: phone ? 28 : 34 }}>Zostatok <span className="hl">a platby</span></h2>
      <div className={"card" + (balance < 0 ? " hl" : "")} style={{ padding: 16 }}>
        <div className="field-lbl" style={{ marginBottom: 4 }}>Môj účet</div>
        <div className="display" style={{ fontSize: 38, lineHeight: 1, color: balance < 0 ? "var(--danger)" : "var(--ok-deep)" }}>{eurT(balance)}</div>
        <div className="sub" style={{ marginTop: 6 }}>{balance < 0 ? "Nedoplatok — po zaplatení sa zostatok vyrovná do 1–2 dní." : "Všetko vyrovnané."}</div>
        {balance < 0 && <button className="btn accent block" style={{ marginTop: 14 }} onClick={onPay}>Zaplatiť {eur(-balance)}</button>}
      </div>
      <div className="card flat" style={{ padding: "4px 14px" }}>
        {P2.tx.map(([d, n, a], i) => (
          <div key={i} className="p2-tx">
            <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{n}</div><div className="sub mono" style={{ fontSize: 11.5 }}>{d}</div></div>
            <span className="mono" style={{ fontWeight: 700, color: a < 0 ? "var(--ink)" : "var(--ok-deep)", whiteSpace: "nowrap" }}>{a > 0 ? "+" : ""}{eur(a)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- the screen ---------- */
function FPortal2({ device, nav, subState }) {
  const D = window.FP_DATA;
  const phone = device === "phone";
  const pad = phone ? 16 : 28;
  const state = subState === "first" ? "open" : (subState || "open");
  const isOpen = state === "open", isClosed = state === "closed", isLocked = state === "locked";

  const [view, setView] = useP2(subState === "first" ? "explainer" : "shop"); // shop | history | balance | explainer
  const [menu, setMenu] = useP2(false);
  const [modal, setModal] = useP2(isClosed ? "closed" : null); // closed | share | invite | profile | pay | paydebt | pickup | success
  const [closedSeen, setClosedSeen] = useP2(false);
  const [cat, setCat] = useP2(D.tabs[0]);
  const [cart, setCart] = useP2(isOpen ? { "p1|250g": 2, "p6|1kg": 1 } : {});
  const [submitted, setSubmitted] = useP2(false);
  const [dirty, setDirty] = useP2(false);

  const priceOf = useP2M(() => {
    const m = {};
    Object.entries(D.products).forEach(([pc, ps]) => ps.forEach((p) => p.variants.forEach(([s, pr]) => { m[p.id + "|" + s] = { price: pr, name: p.name, size: s, cat: pc }; })));
    return m;
  }, []);
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([k, q]) => ({ ...priceOf[k], qty: q, total: priceOf[k].price * q }));
  const total = lines.reduce((s, l) => s + l.total, 0);
  const setQty = (key, v) => { if (!isOpen) return; setCart({ ...cart, [key]: v }); setDirty(true); };
  const orderTotal = P2.order.reduce((s, [, , p]) => s + p, 0);
  const balance = D.friend.balance;

  const go = (k) => {
    setMenu(false);
    if (k === "logout") return nav("f-login");
    if (["share", "invite", "profile"].includes(k)) return setModal(k);
    setView(k);
  };

  const subtitle = view === "shop" ? (isLocked ? "Vaša objednávka" : "Aktuálna ponuka") : view === "history" ? "Moje objednávky" : view === "balance" ? "Zostatok a platby" : "Ako to funguje";
  const ticker = isLocked ? "+++ OBJEDNÁVKY UZAMKNUTÉ +++ KÁVA JE NA CESTE +++" : isClosed ? "+++ OBJEDNÁVKY ZATVORENÉ +++ ĎALŠIE KOLO O 4 TÝŽDNE +++" : "+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++";

  const catalog = (
    <React.Fragment>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <span className="field-lbl">{isOpen ? "Ponuka" : isLocked ? "Ponuka" : "Minulá ponuka"} · {P2.cycle.short}</span>
        <span className="sub mono" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{isOpen ? `${P2.cycle.count} druhov` : "len na prezretie"}</span>
      </div>
      <div className={isOpen ? "" : "p2-ro"} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {window.CatTabs ? <CatTabs cats={D.tabs} cat={cat} setCat={setCat} /> : (
          <div className="cat-tabs">
            {D.tabs.map((t) => <span key={t} className={"tab" + (t === cat ? " on" : "")} onClick={(e) => { window.snapTab(e); setCat(t); }}>{t}</span>)}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(D.products[cat] || []).map((p) => <CoffeeCard key={p.id} p={p} cart={cart} setQty={setQty} disabled={!isOpen} phone={phone} />)}
        </div>
      </div>
    </React.Fragment>
  );

  return (
    <div data-screen-label="Portál v2" style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <div className="appbar">
        {view === "explainer"
          ? <span className="p2-icobtn" onClick={() => setView("shop")}>{I.back()}</span>
          : <span className="p2-icobtn" aria-label="Menu" onClick={() => setMenu(true)}>{I2.menu()}</span>}
        <div className="titles">
          <span className="t">Pod<span style={{ color: "var(--accent, #ff2d87)" }}>pult</span>ovka</span>
          <span className="s">{subtitle}</span>
        </div>
        <div className="grow"></div>
        <span className="chip acc" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => setModal("invite")}>{I.invite()} Pozvať</span>
        {!isOpen && <span className="chip p2-lock" title={isLocked ? "Objednávky sú uzamknuté" : "Objednávky sú zatvorené"}>{I.lock()}</span>}
      </div>
      <BrandStrip tickerText={ticker} />

      <div style={{ padding: pad, paddingBottom: 8, maxWidth: 760, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        {view === "explainer" && <Explainer phone={phone} onDone={() => setView("shop")} />}
        {view === "history" && <HistoryView phone={phone} />}
        {view === "balance" && <BalanceView phone={phone} balance={balance} onPay={() => setModal("paydebt")} />}

        {view === "shop" && (
          <React.Fragment>
            {isOpen && (
              <div className="banner slim"><span className="dot"></span>
                <div style={{ minWidth: 0, flex: 1 }}><b>Objednávky do {P2.cycle.closes}</b> Káva príde okolo {P2.cycle.expected} — <a href="#" style={{ fontWeight: 700 }} onClick={(e) => { e.preventDefault(); setView("explainer"); }}>Ako to funguje?</a></div>
              </div>
            )}
            {isClosed && closedSeen && (
              <div className="banner warn slim"><span className="dot"></span><div style={{ minWidth: 0, flex: 1 }}><b>Objednávky sú zatvorené.</b> Ďalšia objednávka približne <b>{P2.next.date}</b>.</div></div>
            )}
            {isOpen && submitted && !dirty && lines.length > 0 && (
              <div className="banner ok slim"><span className="dot"></span><div style={{ minWidth: 0, flex: 1 }}><b>Objednávka odoslaná.</b> Do uzamknutia ju môžete meniť.</div></div>
            )}
            {balance < 0 && (
              <div className="banner danger slim" style={{ alignItems: "center" }}><span className="dot" style={{ marginTop: 0 }}></span>
                <div style={{ minWidth: 0, flex: 1 }}><b>Nedoplatok {eur(-balance)}</b> z minulého kola</div>
                <button className="btn sm accent" onClick={() => setModal("paydebt")}>Zaplatiť</button>
              </div>
            )}

            {isLocked && (
              <React.Fragment>
                <div className="card hl" style={{ padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div className="display" style={{ fontSize: 22, lineHeight: 1 }}>Vaša objednávka</div>
                    <span className="badge ok">Odoslaná</span>
                  </div>
                  <div className="p2-lines" style={{ marginTop: 12 }}>
                    {P2.order.map(([n, q, p], i) => <div key={i} className="ln"><span>{n} <span className="mono">×{q}</span></span><span className="mono">{eur(p)}</span></div>)}
                  </div>
                  <div className="p2-tot"><span className="field-lbl">Spolu</span><span className="display" style={{ fontSize: 22, lineHeight: 1 }}>{eurT(orderTotal)}</span></div>
                  <div style={{ marginTop: 12, borderTop: "2px solid rgba(10,10,10,0.12)", paddingTop: 12 }}>
                    <span className="badge" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{I2.pin()} {P2.pickup}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10 }}>
                    <span className="badge warn">Nezaplatené</span>
                    <button className="btn sm accent" onClick={() => setModal("pay")}>Zaplatiť {eur(orderTotal)}</button>
                  </div>
                </div>
                <div className="card" style={{ padding: "16px 16px 4px" }}>
                  <div className="field-lbl" style={{ marginBottom: 12 }}>Kde je vaša káva</div>
                  <Timeline steps={P2.stages} />
                </div>
                <div className="banner slim"><span className="dot"></span><div style={{ minWidth: 0, flex: 1 }}><b>Ďalšia objednávka</b> približne <b>{P2.next.date}</b> — ponuku si už môžete prezrieť nižšie.</div></div>
              </React.Fragment>
            )}

            {catalog}
          </React.Fragment>
        )}
      </div>

      {view === "shop" && isOpen && (
        <div className="cartbar">
          {dirty && submitted && lines.length > 0 && (
            <div className="banner warn slim" style={{ marginBottom: 8 }}><span className="dot"></span><span><b>Zmeny neboli odoslané.</b> Stlačte „Aktualizovať“.</span></div>
          )}
          <div className="meta">
            <span className="sum">{eurT(total)}</span>
            <span className="deadline">Objednávka do: {P2.cycle.closesDate}</span>
          </div>
          <div className="actions">
            <button className="btn" style={{ flex: "0 0 52px", padding: 0 }} aria-label="Zdieľať s kolegami" onClick={() => setModal("share")}>{I.share()}</button>
            <button className="btn accent" disabled={lines.length === 0} onClick={() => { submitted ? (setDirty(false), setModal("success")) : setModal("pickup"); }}>
              {submitted ? "Aktualizovať" : "Odoslať objednávku"}
            </button>
          </div>
          <details>
            <summary>Zobraziť položky v košíku</summary>
            {window.CartLines ? <CartLines lines={lines} order={D.tabs} /> : (
              <div className="lines">
                {lines.length === 0 ? <span className="sub">Košík je prázdny</span> : lines.map((l, i) => (
                  <div className="ln" key={i}><span>{l.name} ({l.size}) ×{l.qty}</span><span className="mono">{eur(l.total)}</span></div>
                ))}
              </div>
            )}
          </details>
        </div>
      )}

      {menu && <MenuDrawer view={view} open={isOpen} balance={balance} cartTotal={total} onClose={() => setMenu(false)} go={go} />}

      {modal === "closed" && (
        <Modal title={<span>Objednávky sú<br />zatvorené</span>} onClose={() => { setModal(null); setClosedSeen(true); }}
          footer={<React.Fragment>
            <button className="btn" onClick={() => { setModal(null); setClosedSeen(true); setView("explainer"); }}>Ako to funguje</button>
            <button className="btn accent" onClick={() => { setModal(null); setClosedSeen(true); }}>Prezrieť ponuku</button>
          </React.Fragment>}>
          <div className="sub" style={{ fontSize: 14 }}>Káva sa objednáva spoločne, v termínoch — pár dní naraz, potom ju nakúpime v pražiarni a rozdáme si ju.</div>
          <div className="card flat" style={{ padding: 14, background: "var(--accent-soft)" }}>
            <div className="field-lbl" style={{ marginBottom: 6 }}>Ďalšia objednávka sa otvorí približne</div>
            <div className="display" style={{ fontSize: 38, lineHeight: .9 }}>{P2.next.date}</div>
            <div className="sub" style={{ marginTop: 6, fontWeight: 700 }}>{P2.next.inWeeks} · dáme vedieť cez WhatsApp</div>
          </div>
          <div>
            <div className="field-lbl" style={{ marginBottom: 8 }}>Kde sme teraz</div>
            <Dots now={0} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", fontWeight: 700 }}>Pauza</span>
              <span className="sub mono" style={{ fontSize: 11, textTransform: "uppercase" }}>Objednávky</span>
              <span className="sub mono" style={{ fontSize: 11, textTransform: "uppercase" }}>Doručenie</span>
            </div>
          </div>
        </Modal>
      )}
      {modal === "share" && <ShareModal onClose={() => setModal(null)} />}
      {modal === "profile" && <ProfileModal onClose={() => setModal(null)} />}
      {modal === "invite" && (
        <Modal title="Pozvi priateľa" onClose={() => setModal(null)} footer={<button className="btn" onClick={() => setModal(null)}>Zavrieť</button>}>
          <div className="sub">Pošlite tento odkaz priateľovi. Po registrácii ho správca pridá do skupiny.</div>
          <CopyRow value="https://podpultovka.biz/invite/LEGO-9F2K" />
        </Modal>
      )}
      {modal === "pay" && <PaymentModal amount={orderTotal} reference={D.payment.reference(D.friend.name)} onClose={() => setModal(null)} />}
      {modal === "paydebt" && <PaymentModal amount={-balance} reference={`${D.friend.code} / ${D.friend.name} / zostatok`} onClose={() => setModal(null)} />}
      {modal === "pickup" && <PickupModal onClose={() => setModal(null)} onConfirm={() => { setSubmitted(true); setDirty(false); setModal("success"); }} />}
      {modal === "success" && (
        <Modal title="Hotovo!" subtitle="Objednávka bola odoslaná. Môžete ju upraviť až do uzamknutia objednávok. Zaplatíte, keď kávu zabalíme." onClose={() => setModal(null)}
          footer={<button className="btn" onClick={() => setModal(null)}>OK</button>}>
          <div className="banner ok slim"><span className="dot"></span><span>Suma: <b className="mono">{eurT(total)}</b> · odber: {P2.pickup}</span></div>
        </Modal>
      )}
    </div>
  );
}

Object.assign(window, { FPortal2, I2, Timeline, Explainer, MenuDrawer });
