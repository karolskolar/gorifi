/* Podpultovka Friends — Guest flow: /g/:token bez účtu (objednávka → potvrdenie → stav) */
const { useState: useGS } = React;

function GuestHeader({ sub }) {
  const D = window.FP_DATA;
  return (
    <React.Fragment>
      <div className="appbar">
        <div className="titles">
          <span className="t">Pod<span style={{ color: "var(--accent, #ff2d87)" }}>pult</span>ovka</span>
          <span className="s">{sub || "Spoločná objednávka"}</span>
        </div>
        <div className="grow"></div>
        <span className="chip acc">Bez účtu</span>
      </div>
      <BrandStrip tickerText="+++ KÁVA POD PULTOM +++ BEZ ÚČTU · BEZ REČÍ +++ POŠLI ODKAZ ĎALEJ +++" />
    </React.Fragment>
  );
}

function GuestInviteCta() {
  const [open, setOpen] = useGS(false);
  const [done, setDone] = useGS(false);
  const D = window.FP_DATA;
  if (done) return (
    <div className="banner ok slim"><span className="dot"></span><span><b>Žiadosť o účet je odoslaná.</b> Správca sa vám ozve.</span></div>
  );
  return (
    <div className="card" style={{ padding: "10px 12px", background: "var(--hi)" }}>
      {!open ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ width: 36, height: 36, flexShrink: 0, border: "3px solid var(--nb-ink)", borderRadius: 9, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "2px 2px 0 var(--nb-ink)", transform: "rotate(-3deg)" }}>{I.invite()}</span>
          <div className="display" style={{ flex: 1, minWidth: 0, fontSize: 17, lineHeight: 0.95 }}>Chcete si objednať sami?</div>
          <button className="btn sm" style={{ flexShrink: 0, minHeight: 34, padding: "6px 10px", fontSize: 12.5 }} onClick={() => setOpen(true)}>Požiadať o účet</button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 4 }}>
          <div className="display" style={{ fontSize: 21, lineHeight: 0.95 }}>Žiadosť o vlastný účet</div>
          <div className="sub" style={{ fontSize: 13 }}>Správca vás pridá medzi priateľov a nabudúce si objednáte priamo.</div>
          <Field label="Meno *"><Input defaultValue={D.guestOrder.name} /></Field>
          <Field label="Mobil *"><Input defaultValue={D.guestOrder.phone} inputMode="tel" /></Field>
          <Field label="E-mail (nepovinné)"><Input placeholder="meno@example.com" inputMode="email" /></Field>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" style={{ flex: 1 }} onClick={() => setOpen(false)}>Späť</button>
            <button className="btn sm dark" style={{ flex: 1 }} onClick={() => { setDone(true); setOpen(false); }}>Odoslať žiadosť</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- /g/:token — guest ordering ---------- */
function GOrder({ device, nav }) {
  const D = window.FP_DATA;
  const phone = device === "phone";
  const pad = phone ? 16 : 28;
  const [cat, setCat] = useGS("Filter");
  const [cart, setCart] = useGS({ "p5|250g": 1, "p6|250g": 1, "p7|250g": 1 });
  const [checkout, setCheckout] = useGS(false);
  const [err, setErr] = useGS("");
  const [name, setName] = useGS("");
  const [phoneNr, setPhoneNr] = useGS("");

  const priceOf = {};
  Object.values(D.products).flat().forEach((p) => p.variants.forEach(([s, pr]) => { priceOf[p.id + "|" + s] = { price: pr, name: p.name, size: s }; }));
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([k, q]) => ({ ...priceOf[k], qty: q, total: priceOf[k].price * q }));
  const total = lines.reduce((s, l) => s + l.total, 0);
  const setQty = (key, v) => setCart({ ...cart, [key]: v });

  const submit = () => {
    if (!name.trim()) { setErr("Zadajte svoje meno."); return; }
    if (phoneNr.replace(/\D/g, "").length < 9) { setErr("Zadajte telefónne číslo (aspoň 9 číslic)."); return; }
    nav("g-confirm");
  };

  return (
    <div data-screen-label="Guest — objednávka" style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <GuestHeader sub="Objednávka cez odkaz" />
      <div style={{ padding: pad, paddingBottom: 8, maxWidth: 760, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        <div className="card hl" style={{ padding: phone ? 16 : 20 }}>
          <h1 className="h-screen" style={{ fontSize: phone ? 30 : 38 }}>{D.cycle.name}</h1>
          <div className="sub" style={{ marginTop: 8, fontSize: 14 }}>Spoločná objednávka · organizuje <b style={{ color: "var(--ink)" }}>{D.friend.name}</b></div>
          <div className="mono" style={{ fontSize: 12.5, marginTop: 6, display: "flex", alignItems: "center", gap: 6, color: "var(--ink-dim)" }}>{I.cal()} Objednávka do: {D.cycle.date}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
            <span className="badge acc">Login netreba</span>
            <span className="badge">Platba prevodom</span>
            <span className="badge acc-o">Tovar odovzdá {D.friend.name}</span>
          </div>
          <div className="sub" style={{ marginTop: 10, fontSize: 13 }}>Vyberte si tovar, na konci zadáte len meno a telefón.</div>
        </div>

        <div className="cat-tabs">
          {D.tabs.map((t) => <span key={t} className={"tab" + (t === cat ? " on" : "")} onClick={(e) => { window.snapTab(e); setCat(t); }}>{t}</span>)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(D.products[cat] || []).map((p) => <CoffeeCard key={p.id} p={p} cart={cart} setQty={setQty} phone={phone} />)}
        </div>
      </div>

      <div className="cartbar">
        <div className="meta">
          <span className="deadline">Objednávka do: {D.cycle.date}</span>
          <span className="sub" style={{ fontSize: 13 }}>Položiek: {lines.length}</span>
        </div>
        <div className="meta" style={{ marginTop: 2, alignItems: "center" }}>
          <span className="sum">Celkom: {total.toFixed(2)} EUR</span>
          <button className="btn accent sm" disabled={lines.length === 0} onClick={() => { setErr(""); setCheckout(true); }}>Objednať</button>
        </div>
        <details>
          <summary>Zobraziť položky v košíku</summary>
          <div className="lines">
            {lines.map((l, i) => <div className="ln" key={i}><span>{l.name} ({l.size}) ×{l.qty}</span><span className="mono">{l.total.toFixed(2)} EUR</span></div>)}
          </div>
        </details>
      </div>

      {checkout && (
        <Modal title="Dokončiť objednávku" subtitle={<span>Suma na úhradu: <b className="mono" style={{ color: "var(--ink)" }}>{total.toFixed(2)} EUR</b>. Platba prevodom, tovar vám odovzdá {D.friend.name}.</span>} onClose={() => setCheckout(false)}
          footer={<React.Fragment>
            <button className="btn" onClick={() => setCheckout(false)}>Späť</button>
            <button className="btn accent" onClick={submit}>Odoslať objednávku</button>
          </React.Fragment>}>
          <Field label="Meno *"><Input placeholder="Meno a priezvisko" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Mobil *"><Input placeholder="0901 234 567" inputMode="tel" value={phoneNr} onChange={(e) => setPhoneNr(e.target.value)} /></Field>
          <Field label="E-mail (nepovinné)"><Input placeholder="meno@example.com" inputMode="email" /></Field>
          {err && <div className="banner danger slim"><span className="dot"></span><span>{err}</span></div>}
        </Modal>
      )}
    </div>
  );
}

/* ---------- confirmation (§UC-GSO-003) ---------- */
function GConfirm({ device, nav }) {
  const D = window.FP_DATA;
  const phone = device === "phone";
  const [pay, setPay] = useGS(false);
  const g = D.guestOrder;
  return (
    <div data-screen-label="Guest — potvrdenie">
      <GuestHeader sub="Objednávka odoslaná" />
      <div style={{ padding: phone ? 16 : 28, maxWidth: 520, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ textAlign: "center", marginTop: 6 }}>
          <span className="badge ok-solid" style={{ fontSize: 13, padding: "6px 14px", transform: "rotate(-2deg)" }}>✔ Odoslané</span>
          <h1 className="h-screen" style={{ fontSize: phone ? 34 : 40, marginTop: 12 }}>Objednávka je <span className="hl">odoslaná</span></h1>
          <div className="sub" style={{ marginTop: 10 }}>{D.cycle.name} · organizuje {D.friend.name}</div>
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="field-lbl" style={{ margin: 0 }}>Suma na úhradu</span>
            <span className="display" style={{ fontSize: 24 }}>{g.total.toFixed(2)} EUR</span>
          </div>
          <hr className="divider" style={{ margin: "12px 0" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 13.5, color: "var(--ink-dim)" }}>
            {g.items.map(([label, price], i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>{label}</span><span className="mono">{price.toFixed(2)}</span></div>)}
          </div>
        </div>

        <button className="btn ok block" onClick={() => setPay(true)}>Zaplatiť</button>

        <Field label="Odkaz na vašu objednávku — uložte si ho">
          <CopyRow value={g.statusUrl} />
        </Field>
        <GuestInviteCta />
        <button className="btn ghost sm" onClick={() => nav("g-status")} style={{ alignSelf: "center" }}>Zobraziť stav objednávky {I.chev()}</button>
      </div>
      {pay && <PaymentModal amount={g.total} reference={D.payment.reference("Karol")} onClose={() => setPay(false)} />}
    </div>
  );
}

/* ---------- /g/:token/o/:orderToken — status page (4 states) ---------- */
function GStatus({ device, nav, subState }) {
  const D = window.FP_DATA;
  const phone = device === "phone";
  const g = D.guestOrder;
  const st = subState || "editable"; // editable | paid | locked | cancelled
  const cancelled = st === "cancelled";
  const paid = st === "paid";
  const locked = st === "locked";
  const [pay, setPay] = useGS(false);
  const [editing, setEditing] = useGS(false);
  const [cancelAsk, setCancelAsk] = useGS(false);
  const [cart, setCart] = useGS({ "p5|250g": 1, "p6|250g": 1, "p7|250g": 1 });
  const [cat, setCat] = useGS("Filter");

  const priceOf = {};
  Object.values(D.products).flat().forEach((p) => p.variants.forEach(([s, pr]) => { priceOf[p.id + "|" + s] = { price: pr, name: p.name, size: s }; }));
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([k, q]) => ({ ...priceOf[k], qty: q, total: priceOf[k].price * q }));
  const editTotal = lines.reduce((s, l) => s + l.total, 0);

  if (editing) {
    return (
      <div data-screen-label="Guest — úprava objednávky" style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
        <GuestHeader sub="Úprava objednávky" />
        <div style={{ padding: phone ? 16 : 28, paddingBottom: 8, maxWidth: 760, margin: "0 auto", width: "100%", flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="banner slim"><span className="dot"></span><span>Upravujete objednávku pre <b>{g.name}</b>. Zmeny sa prejavia po uložení.</span></div>
          <div className="cat-tabs">
            {D.tabs.map((t) => <span key={t} className={"tab" + (t === cat ? " on" : "")} onClick={(e) => { window.snapTab(e); setCat(t); }}>{t}</span>)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {(D.products[cat] || []).map((p) => <CoffeeCard key={p.id} p={p} cart={cart} setQty={(k, v) => setCart({ ...cart, [k]: v })} phone={phone} />)}
          </div>
        </div>
        <div className="cartbar">
          <div className="meta" style={{ alignItems: "center" }}>
            <span className="sum">Celkom: {editTotal.toFixed(2)} EUR</span>
            <span className="sub" style={{ fontSize: 13 }}>Položiek: {lines.length}</span>
          </div>
          <div className="actions">
            <button className="btn sm" onClick={() => setEditing(false)}>Späť</button>
            <button className="btn accent sm" onClick={() => setEditing(false)}>Uložiť zmeny</button>
          </div>
          <button className="btn ghost sm" style={{ color: "var(--danger)", marginTop: 4 }} onClick={() => setCancelAsk(true)}>Zrušiť objednávku</button>
        </div>
        {cancelAsk && <GCancelModal onKeep={() => setCancelAsk(false)} onCancel={() => { setCancelAsk(false); setEditing(false); }} />}
      </div>
    );
  }

  return (
    <div data-screen-label="Guest — stav objednávky">
      <GuestHeader sub="Vaša objednávka" />
      <div style={{ padding: phone ? 16 : 28, maxWidth: 520, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <h1 className="h-screen" style={{ fontSize: phone ? 30 : 36 }}>{D.cycle.name}</h1>
          <div className="sub" style={{ marginTop: 8 }}>Vaša objednávka · organizuje a odovzdá {D.friend.name}</div>
          <div style={{ fontWeight: 700, marginTop: 4 }}>{g.name}</div>
        </div>

        {cancelled ? (
          <div className="banner danger"><span className="dot"></span><span>Táto objednávka bola <b>zrušená</b>. Ak si chcete objednať znova, požiadajte kolegu o odkaz na spoločnú objednávku.</span></div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span className={"statuspill " + (paid ? "ok" : "warn")}><span className="sq"></span>{paid ? "Zaplatené" : "Nezaplatené"}</span>
            <span className="statuspill off"><span className="sq"></span>Zatiaľ neodovzdané</span>
          </div>
        )}

        <div className="card" style={{ padding: 16 }}>
          {cancelled && <div className="field-lbl">Zrušené položky</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5, color: "var(--ink-dim)", textDecoration: cancelled ? "line-through" : "none" }}>
            {g.items.map(([label, price], i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>{label}</span><span className="mono">{price.toFixed(2)}</span></div>)}
          </div>
          {!cancelled && (
            <React.Fragment>
              <hr className="divider" style={{ margin: "12px 0" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="field-lbl" style={{ margin: 0 }}>Celkom</span>
                <span className="display" style={{ fontSize: 22 }}>{g.total.toFixed(2)} EUR</span>
              </div>
            </React.Fragment>
          )}
        </div>

        {!cancelled && (
          <React.Fragment>
            {paid ? null : st === "editable" ? (
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" style={{ flex: 1 }} onClick={() => setEditing(true)}>Upraviť</button>
                <button className="btn ok" style={{ flex: 1.6 }} onClick={() => setPay(true)}>Zaplatiť</button>
              </div>
            ) : (
              <button className="btn ok block" onClick={() => setPay(true)}>Zaplatiť</button>
            )}
          </React.Fragment>
        )}

        {paid && (
          <button className="btn ghost sm" style={{ color: "var(--danger)" }} onClick={() => setCancelAsk(true)}>Zrušiť objednávku</button>
        )}
        {locked && (
          <div className="banner warn slim"><span className="dot"></span><span>Objednávanie v tomto cykle je uzavreté, objednávku už nie je možné upraviť.</span></div>
        )}

        {!cancelled && <GuestInviteCta />}
      </div>
      {pay && <PaymentModal amount={g.total} reference={D.payment.reference("Karol")} onClose={() => setPay(false)} />}
      {cancelAsk && <GCancelModal onKeep={() => setCancelAsk(false)} onCancel={() => setCancelAsk(false)} />}
    </div>
  );
}

function GCancelModal({ onKeep, onCancel }) {
  return (
    <Modal title="Zrušiť objednávku?" subtitle="Objednávka sa zruší a už ju nebude možné obnoviť. Ak si budete chcieť objednať znova, požiadajte kolegu o odkaz." onClose={onKeep}
      footer={<React.Fragment>
        <button className="btn" onClick={onKeep}>Ponechať</button>
        <button className="btn danger" onClick={onCancel}>Zrušiť objednávku</button>
      </React.Fragment>}>
      <div className="banner danger slim"><span className="dot"></span><span>Toto sa nedá vrátiť späť.</span></div>
    </Modal>
  );
}

/* ---------- dead link states ---------- */
function GDead({ device, subState }) {
  const phone = device === "phone";
  const st = subState || "notfound"; // notfound | inactive | closed
  const copy = {
    notfound: { t: "Odkaz neexistuje", d: "Tento odkaz sme nenašli. Skontrolujte, či je skopírovaný celý." },
    inactive: { t: "Odkaz už nie je aktívny", d: "Kolega, ktorý objednávku organizuje, tento odkaz deaktivoval." },
    closed: { t: "Objednávanie je uzavreté", d: "Cyklus sa medzičasom uzamkol — objednávky už neprijímame." },
  }[st];
  return (
    <div data-screen-label="Guest — mŕtvy odkaz" style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
      <GuestHeader sub="Objednávka cez odkaz" />
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: phone ? 20 : 40 }}>
        <div className="card" style={{ padding: phone ? 22 : 30, maxWidth: 400, textAlign: "center", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <span className="badge danger" style={{ fontSize: 13, padding: "6px 14px", transform: "rotate(-2deg)" }}>{I.lock()} Slepá ulička</span>
          <h1 className="h-screen" style={{ fontSize: phone ? 32 : 38 }}>{copy.t}</h1>
          <div className="sub" style={{ fontSize: 14 }}>{copy.d}</div>
          <div className="sub" style={{ fontSize: 13.5 }}>Ak ste odkaz dostali od kolegu, požiadajte ho o nový.</div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { GOrder, GConfirm, GStatus, GDead, GuestHeader, GuestInviteCta, GCancelModal });
