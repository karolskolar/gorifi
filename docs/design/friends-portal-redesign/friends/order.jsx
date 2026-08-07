/* Podpultovka Friends — Objednávka: Moja objednávka ⇄ Kolegovia, share, platba, prevzatie */
const { useState: useOS, useMemo: useOM } = React;

/* ---------- share dialog (FriendPortal + FriendOrder) ---------- */
function ShareModal({ onClose }) {
  const D = window.FP_DATA;
  const [active, setActive] = useOS(true);
  const [regen, setRegen] = useOS(false);
  return (
    <Modal title="Zdieľať s kolegami" subtitle={<span><b style={{ color: "var(--ink)" }}>{D.cycle.name}</b><br />Kolegovia si objednajú cez váš odkaz — bez registrácie. Zásielku prevezmete vy a odovzdáte im ju.</span>} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Zavrieť</button>}>
      {!active && (
        <div className="banner warn slim"><span className="dot"></span><span><b>Odkaz je deaktivovaný</b> — kolegovia si cez neho nemôžu objednať.</span></div>
      )}
      <CopyRow value={D.shareLink} />
      <button className="btn accent block">{I.share()} Zdieľať odkaz</button>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn ghost sm" onClick={() => setActive(!active)}>{active ? "Deaktivovať odkaz" : "Znova aktivovať"}</button>
        {!regen && <button className="btn ghost sm" onClick={() => setRegen(true)}>Vygenerovať nový odkaz</button>}
      </div>
      {regen && (
        <div className="confirmbox">
          <span><b>Starý odkaz prestane fungovať.</b> Objednávky, ktoré vám kolegovia už poslali, zostanú zachované.</span>
          <div className="row">
            <button className="btn sm dark" onClick={() => setRegen(false)}>Áno, vygenerovať</button>
            <button className="btn sm ghost" onClick={() => setRegen(false)}>Zrušiť</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- product card (coffee) ---------- */
function VariantBox({ size, price, qty, onQty, disabled }) {
  return (
    <div className={"vbox" + (qty > 0 ? " sel" : "")}>
      <div className="vrow"><span className="vsize">{size}</span><span className="vprice">{price.toFixed(2)} EUR</span></div>
      <Stepper value={qty} onChange={onQty} disabled={disabled} />
    </div>
  );
}

function CoffeeCard({ p, cart, setQty, disabled, phone }) {
  const D = window.FP_DATA;
  const av = D.availability[p.id];
  return (
    <div className="card" style={{ padding: phone ? 14 : 18 }}>
      <div style={{ display: "flex", gap: 13, alignItems: "stretch" }}>
        <ProductImg img={p.img} size={phone ? 58 : 70} label={p.roaster} stretch />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="display" style={{ fontSize: phone ? 19 : 21, lineHeight: 0.95 }}>{p.name}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            <span className="badge" style={{ fontSize: 11, padding: "2px 7px" }}>{p.roast}</span>
            <span className="badge acc-o" style={{ fontSize: 11, padding: "2px 7px" }}>{p.roaster}</span>
          </div>
          <div className="sub" style={{ marginTop: 7, fontSize: 13 }}>{p.spec}</div>
          <div className="mono" style={{ fontSize: 12.5, color: "var(--ink-faint)", marginTop: 2 }}>{p.notes}</div>
        </div>
      </div>
      {av && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          <div style={{ flex: 1, height: 10, border: "2px solid var(--nb-ink)", borderRadius: 6, overflow: "hidden", background: "#fff" }}>
            <div style={{ width: `${(1 - av.remainingKg / av.limitKg) * 100}%`, height: "100%", background: "var(--accent)" }}></div>
          </div>
          <span className="mono" style={{ fontSize: 11.5, whiteSpace: "nowrap", color: "var(--warn)" }}>Zostáva {av.remainingKg} kg z {av.limitKg} kg</span>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: p.variants.length > 1 ? "1fr 1fr" : "1fr", gap: 10, marginTop: 13 }}>
        {p.variants.map(([size, price]) => {
          const key = p.id + "|" + size;
          return <VariantBox key={key} size={size} price={price} qty={cart[key] || 0} onQty={(v) => setQty(key, v)} disabled={disabled} />;
        })}
      </div>
    </div>
  );
}

function BakeryCard({ p, cart, setQty, disabled, phone }) {
  return (
    <div className="card" style={{ padding: phone ? 14 : 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <div className="display" style={{ fontSize: phone ? 19 : 21, lineHeight: 0.95 }}>{p.name}</div>
        <span className="mono sub" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{p.weight}</span>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary className="sub" style={{ cursor: "pointer", fontSize: 13 }}>Zloženie</summary>
        <div className="sub" style={{ fontSize: 13, marginTop: 4 }}>{p.composition}</div>
      </details>
      <div style={{ display: "grid", gridTemplateColumns: p.variants.length > 1 ? "1fr 1fr" : "1fr", gap: 10, marginTop: 12 }}>
        {p.variants.map(([size, price]) => {
          const key = p.id + "|" + size;
          return <VariantBox key={key} size={size} price={price} qty={cart[key] || 0} onQty={(v) => setQty(key, v)} disabled={disabled} />;
        })}
      </div>
    </div>
  );
}

/* ---------- kolegovia panel ---------- */
function SubOrderCard({ o, locked, delivered, onDelivered, onRemove }) {
  const D = window.FP_DATA;
  const [open, setOpen] = useOS(o.status !== "cancelled");
  const [confirm, setConfirm] = useOS(false);
  const cancelled = o.status === "cancelled";
  return (
    <div className={"suborder" + (cancelled ? " cancelled" : "")}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", minWidth: 0 }} onClick={() => setOpen(!open)}>
          <span className={"chev" + (open ? " open" : "")} style={{ marginTop: 3 }}>{I.chev()}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>{o.name}</div>
            <div className="mono sub" style={{ fontSize: 12 }}>{o.phone}</div>
            {!open && <div className="sub" style={{ fontSize: 12 }}>{o.items.length} {o.items.length === 1 ? "položka" : o.items.length < 5 ? "položky" : "položiek"}</div>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {cancelled ? <span className="badge muted">Zrušené</span> :
            o.paid ? <span className="badge ok">Zaplatené</span> : <span className="badge warn">Nezaplatené</span>}
        </div>
      </div>
      {open && !cancelled && (
        <ul className="items">
          {o.items.map(([label, price], i) => <li key={i}><span style={{ minWidth: 0 }}>{label}</span><span className="mono">{price.toFixed(2)}</span></li>)}
        </ul>
      )}
      {cancelled ? (
        <div className="foot"><span className="sub" style={{ textDecoration: "line-through" }}>{D.subTotal(o).toFixed(2)} EUR</span></div>
      ) : (
        <div className="foot">
          <span className="total">{D.subTotal(o).toFixed(2)} EUR</span>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 700, fontSize: 13.5 }}>
              <Checkbox ok big checked={delivered} onChange={onDelivered} /> Odovzdané
            </label>
            {!locked && !confirm && <button className="btn ghost sm" onClick={() => setConfirm(true)}>Odstrániť</button>}
          </div>
        </div>
      )}
      {confirm && (
        <div className="confirmbox" style={{ marginTop: 10 }}>
          <span>Objednávka kolegu sa zruší. Kolega ju uvidí ako zrušenú a už si ju nebude môcť upraviť.</span>
          <div className="row">
            <button className="btn sm danger" onClick={() => { setConfirm(false); onRemove(); }}>Áno, odstrániť</button>
            <button className="btn sm ghost" onClick={() => setConfirm(false)}>Nie</button>
          </div>
        </div>
      )}
    </div>
  );
}

function GuestsPanel({ locked, empty, onShare }) {
  const D = window.FP_DATA;
  const [subs, setSubs] = useOS(empty ? [] : D.subOrders);
  const [delivered, setDelivered] = useOS(() => Object.fromEntries(D.subOrders.map((o) => [o.id, !!o.delivered])));
  const live = subs.filter((o) => o.status !== "cancelled");
  const total = live.reduce((s, o) => s + D.subTotal(o), 0);
  const cnt = live.length;
  const label = cnt === 1 ? "1 kolega" : cnt >= 2 && cnt <= 4 ? cnt + " kolegovia" : cnt + " kolegov";

  if (subs.length === 0) {
    return locked ? (
      <div className="sub" style={{ padding: "8px 2px" }}>Cez váš odkaz si nikto neobjednal.</div>
    ) : (
      <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
        <span className="badge acc">Zatiaľ nikto</span>
        <div className="display" style={{ fontSize: 22 }}>Objednávate aj pre kolegov?</div>
        <div className="sub" style={{ maxWidth: 300 }}>Pošlite im odkaz — objednajú si sami, bez registrácie, a vy im tovar odovzdáte.</div>
        <button className="btn accent" style={{ marginTop: 4 }} onClick={onShare}>{I.share()} Zdieľať objednávku s kolegami</button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!locked && (
        <div className="card flat" style={{ padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span className="sub" style={{ fontSize: 13 }}>Ďalší kolegovia sa môžu pridať cez ten istý odkaz.</span>
          <button className="btn sm" onClick={onShare}>{I.share()} Zdieľať odkaz</button>
        </div>
      )}
      <div>
        <div className="display" style={{ fontSize: 24 }}>Objednávky kolegov</div>
        <div className="sub" style={{ marginTop: 4, fontSize: 13.5 }}>
          Objednali {label} · spolu <b className="mono" style={{ color: "var(--ink)" }}>{total.toFixed(2)} EUR</b>. Kolegovia platia priamo správcovi — vaša suma na úhradu sa tým nemení.
        </div>
      </div>
      {subs.map((o) => (
        <SubOrderCard key={o.id} o={o} locked={locked}
          delivered={!!delivered[o.id]}
          onDelivered={(v) => setDelivered({ ...delivered, [o.id]: v })}
          onRemove={() => setSubs(subs.map((s) => s.id === o.id ? { ...s, status: "cancelled" } : s))} />
      ))}
    </div>
  );
}

/* ---------- delivery method modal ---------- */
function PickupModal({ onClose, onConfirm }) {
  const D = window.FP_DATA;
  const [method, setMethod] = useOS("pickup");
  const [loc, setLoc] = useOS(1);
  const RadioRow = ({ checked, onPick, children }) => (
    <label className="card flat" style={{ padding: "11px 13px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", borderColor: checked ? "var(--nb-ink)" : "rgba(10,10,10,0.3)", background: checked ? "var(--accent-soft)" : "#fff" }} onClick={onPick}>
      <span style={{ width: 18, height: 18, borderRadius: "50%", border: "3px solid var(--nb-ink)", background: checked ? "var(--accent)" : "#fff", flexShrink: 0 }}></span>
      <span style={{ minWidth: 0, fontSize: 14 }}>{children}</span>
    </label>
  );
  return (
    <Modal title="Spôsob prevzatia" subtitle="Vyberte, ako chcete dostať objednávku." onClose={onClose}
      footer={<React.Fragment><button className="btn" onClick={onClose}>Zrušiť</button><button className="btn accent" onClick={onConfirm}>Potvrdiť a odoslať</button></React.Fragment>}>
      <RadioRow checked={method === "pickup"} onPick={() => setMethod("pickup")}><b>Osobný odber</b></RadioRow>
      <RadioRow checked={method === "packeta"} onPick={() => setMethod("packeta")}><b>Doručenie Packetou</b> <span className="sub">(+{D.cycle.parcelFee.toFixed(2)} EUR)</span></RadioRow>
      {method === "pickup" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "2px solid rgba(10,10,10,0.12)", paddingTop: 12 }}>
          {D.pickupLocations.map((l) => (
            <RadioRow key={l.id} checked={loc === l.id} onPick={() => setLoc(l.id)}><b>{l.name}</b> <span className="sub">{l.address}</span></RadioRow>
          ))}
          <RadioRow checked={loc === 0} onPick={() => setLoc(0)}><b>Iné</b></RadioRow>
          {loc === 0 && <Input placeholder="Poznámka (voliteľné)" />}
        </div>
      )}
      {method === "packeta" && (
        <div style={{ borderTop: "2px solid rgba(10,10,10,0.12)", paddingTop: 12 }}>
          <Field label="Adresa výdajného miesta *">
            <Input defaultValue={D.friend.packeta} placeholder="napr. Z-BOX Hlavná 15, Bratislava" />
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13.5, marginTop: 10 }}>
            <Checkbox checked={true} onChange={() => {}} /> Uložiť ako predvolenú adresu
          </label>
        </div>
      )}
    </Modal>
  );
}

/* ---------- main order screen ---------- */
function FOrder({ device, nav, startTab, locked, emptyGuests, bakery }) {
  const D = window.FP_DATA;
  const phone = device === "phone";
  const pad = phone ? 16 : 28;
  const cyc = bakery ? D.bakeryCycle : D.cycle;
  const catalog = bakery ? D.bakery : D.products;
  const cats = bakery ? D.bakeryTabs : D.tabs;

  const [mainTab, setMainTab] = useOS(startTab || "own");
  const [cat, setCat] = useOS(cats[0]);
  const [cart, setCart] = useOS(bakery ? {} : { ...Object.fromEntries(Object.entries(D.ownCart).flatMap(([pid, vs]) => Object.entries(vs).map(([v, q]) => [pid + "|" + v, q]))) });
  const [submitted, setSubmitted] = useOS(!bakery);
  const [dirty, setDirty] = useOS(false);
  const [modal, setModal] = useOS(null); // share | pay | pickup | success | cancel

  const priceOf = useOM(() => {
    const m = {};
    Object.values(catalog).flat().forEach((p) => p.variants.forEach(([s, pr]) => { m[p.id + "|" + s] = { price: pr, name: p.name, size: s }; }));
    return m;
  }, [catalog]);

  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([k, q]) => ({ ...priceOf[k], qty: q, total: priceOf[k].price * q }));
  const total = lines.reduce((s, l) => s + l.total, 0);
  const setQty = (key, v) => { if (locked) return; setCart({ ...cart, [key]: v }); setDirty(true); };
  const guestBadge = emptyGuests ? 0 : D.subTotals.pendingDelivery;

  return (
    <div data-screen-label={bakery ? "Objednávka — pekáreň" : "Objednávka — cyklus"} style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <div className="appbar">
        <span className="back" onClick={() => nav("f-portal")}>{I.back()}</span>
        <div className="titles">
          <span className="t">{cyc.name}</span>
          <span className="s">{D.friend.name} · {D.friend.code}</span>
        </div>
        <div className="grow"></div>
        {locked ? <span className="chip">{I.lock()}</span> : <span className="chip acc">Otvorené</span>}
      </div>
      <BrandStrip tickerText={locked ? "+++ OBJEDNÁVKY UZAMKNUTÉ +++ DRŽ JAZYK ZA ZUBAMI +++" : "+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++"} />

      <div style={{ padding: pad, paddingBottom: 8, maxWidth: 760, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        {locked ? (
          <div className="banner warn"><span className="dot"></span><span><b>Objednávky sú uzamknuté.</b> Už nie je možné meniť objednávku.</span></div>
        ) : submitted && !dirty && lines.length > 0 ? (
          <div className="banner ok"><span className="dot"></span><span><b>Vaša objednávka bola odoslaná!</b> Stále ju môžete upraviť až do uzamknutia.</span></div>
        ) : null}

        {!bakery && (
          <div className="tabgroup" role="tablist">
            <span className={"tab" + (mainTab === "own" ? " on" : "")} onClick={() => setMainTab("own")}>Moja objednávka</span>
            <span className={"tab" + (mainTab === "guests" ? " on" : "")} onClick={() => setMainTab("guests")}>
              Kolegovia {guestBadge > 0 && <span className="tabbadge pending" title="Toľkým kolegom ste ešte neodovzdali tovar">{guestBadge}</span>}
            </span>
          </div>
        )}

        {mainTab === "guests" && !bakery ? (
          <GuestsPanel locked={locked} empty={emptyGuests} onShare={() => setModal("share")} />
        ) : (
          <React.Fragment>
            <div className="cat-tabs">
              {cats.map((t) => <span key={t} className={"tab" + (t === cat ? " on" : "")} onClick={(e) => { window.snapTab(e); setCat(t); }}>{t}</span>)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {(catalog[cat] || []).map((p) => bakery
                ? <BakeryCard key={p.id} p={p} cart={cart} setQty={setQty} disabled={locked} phone={phone} />
                : <CoffeeCard key={p.id} p={p} cart={cart} setQty={setQty} disabled={locked} phone={phone} />)}
            </div>
          </React.Fragment>
        )}
      </div>

      {/* sticky cart footer — host's OWN total, on both tabs */}
      <div className="cartbar">
        {!locked && dirty && lines.length > 0 && (
          <div className="banner warn slim" style={{ marginBottom: 8 }}><span className="dot"></span><span><b>Zmeny neboli odoslané.</b> Stlačte „Aktualizovať".</span></div>
        )}
        <div className="meta">
          <span className="deadline">{I.cal ? null : null}Objednávka do: {cyc.date}</span>
          <span className="sub" style={{ fontSize: 13 }}>Položiek: {lines.length}</span>
        </div>
        <div className="meta" style={{ marginTop: 2 }}>
          <span className="sum">Celkom: {total.toFixed(2)} EUR</span>
        </div>
        {!locked && (
          <div className="actions">
            <button className="btn danger sm" style={{ flex: "0 1 auto" }} disabled={lines.length === 0} onClick={() => setModal("cancel")}>Zrušiť</button>
            {submitted && <button className="btn ok sm" onClick={() => setModal("pay")}>Zaplatiť</button>}
            <button className="btn accent sm" disabled={lines.length === 0} onClick={() => { submitted ? (setDirty(false), setModal("success")) : setModal("pickup"); }}>
              {submitted ? "Aktualizovať" : "Odoslať"}
            </button>
          </div>
        )}
        <details>
          <summary>Zobraziť položky v košíku</summary>
          <div className="lines">
            {lines.length === 0 ? <span className="sub">Košík je prázdny</span> : lines.map((l, i) => (
              <div className="ln" key={i}><span>{l.name} ({l.size}) ×{l.qty}</span><span className="mono">{l.total.toFixed(2)} EUR</span></div>
            ))}
          </div>
        </details>
      </div>

      {modal === "share" && <ShareModal onClose={() => setModal(null)} />}
      {modal === "pay" && <PaymentModal amount={total} reference={D.payment.reference(D.friend.name)} onClose={() => setModal(null)} />}
      {modal === "pickup" && <PickupModal onClose={() => setModal(null)} onConfirm={() => { setSubmitted(true); setDirty(false); setModal("success"); }} />}
      {modal === "success" && (
        <Modal title="Hotovo!" subtitle="Objednávka bola odoslaná. Môžete ju upraviť až do uzamknutia cyklu." onClose={() => setModal(null)}
          footer={<button className="btn" onClick={() => setModal(null)}>OK</button>}>
          <div className="banner ok slim"><span className="dot"></span><span>Suma na úhradu: <b className="mono">{total.toFixed(2)} EUR</b></span></div>
          <RevolutBtn />
          <div style={{ textAlign: "center" }}>
            <div className="sub" style={{ marginBottom: 10 }}>Pay by Square (QR kód pre bankovú appku)</div>
            <QRBox />
            <div className="sub mono" style={{ marginTop: 10, fontSize: 12 }}>IBAN: {D.payment.iban}</div>
          </div>
        </Modal>
      )}
      {modal === "cancel" && (
        <Modal title="Zrušiť objednávku?" subtitle="Naozaj chcete zrušiť objednávku a vymazať všetky položky z košíka?" onClose={() => setModal(null)}
          footer={<React.Fragment>
            <button className="btn" onClick={() => setModal(null)}>Nie</button>
            <button className="btn danger" onClick={() => { setCart({}); setSubmitted(false); setDirty(false); setModal(null); }}>Áno, zrušiť</button>
          </React.Fragment>}>
          <div className="banner danger slim"><span className="dot"></span><span>Položky sa vymažú z košíka. Kolegov, ktorí objednali cez váš odkaz, sa to nedotkne.</span></div>
        </Modal>
      )}
    </div>
  );
}

Object.assign(window, { ShareModal, FOrder, GuestsPanel, SubOrderCard, PickupModal, CoffeeCard, BakeryCard, VariantBox });
