/* Podpultovka Friends — Guest link v2 (2026-09): the link works BEFORE the round opens (F9),
   plus the 3-step explainer alternative for guests (Q3.a). States: closed · open3. */
const { useState: useG2 } = React;

const G2 = {
  host: "Lego",
  next: { date: "3. októbra", inWeeks: "o 4 týždne" },
  steps: [
    ["cup", "Objednáte", "Vyberiete kávu, zadáte meno a mobil. Bez registrácie."],
    ["box", "Zabalíme", "Kávu nakúpime v pražiarni a zabalíme. Vtedy zaplatíte cez QR alebo Revolut."],
    ["hand", "Prevezmete", "Od {host}, alebo si ju nechajte poslať cez Packetu."],
  ],
};

function G2Steps({ compact }) {
  return (
    <div style={{ display: "flex", flexDirection: compact ? "row" : "column", gap: compact ? 8 : 14 }}>
      {G2.steps.map(([ic, t, d], i) => (
        <div key={i} style={{ display: "flex", flexDirection: compact ? "column" : "row", gap: compact ? 8 : 12, alignItems: compact ? "center" : "flex-start", textAlign: compact ? "center" : "left", flex: compact ? 1 : "none", minWidth: 0 }}>
          <div style={{ width: compact ? 34 : 44, height: compact ? 34 : 44, flexShrink: 0, border: "3px solid var(--nb-ink)", borderRadius: 10, background: "#fff", boxShadow: "3px 3px 0 var(--nb-ink)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
            {I2[ic]({ width: compact ? 16 : 20, height: compact ? 16 : 20 })}
            <span className="mono" style={{ position: "absolute", top: -9, left: -9, width: 20, height: 20, borderRadius: 999, background: "var(--accent)", color: "var(--accent-ink)", border: "2px solid var(--nb-ink)", fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="display" style={{ fontSize: compact ? 14 : 19, lineHeight: 1 }}>{t}</div>
            {!compact && <div className="sub" style={{ fontSize: 13.5, lineHeight: 1.4, marginTop: 4 }}>{d.replace("{host}", G2.host)}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function G2Roasters() {
  return (
    <div className="sub" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      Káva od <span className="badge" style={{ fontSize: 11, padding: "2px 7px" }}>Goriffee</span> (pražiareň) a <span className="badge acc-o" style={{ fontSize: 11, padding: "2px 7px" }}>Robo</span> (domáci pražič, SCA výbery).
    </div>
  );
}

function GLink2({ device, subState }) {
  const D = window.FP_DATA;
  const phone = device === "phone";
  const pad = phone ? 16 : 28;
  const closed = (subState || "closed") === "closed";
  const [cat, setCat] = useG2(D.tabs[0]);
  const [cart, setCart] = useG2({});
  const [sent, setSent] = useG2(false);
  const [wa, setWa] = useG2(true);
  const [showHow, setShowHow] = useG2(false);
  const setQty = (k, v) => { if (closed) return; setCart({ ...cart, [k]: v }); };
  const total = Object.entries(cart).reduce((s, [k, q]) => { const [pid, size] = k.split("|"); const p = Object.values(D.products).flat().find((x) => x.id === pid); const v = p && p.variants.find(([sz]) => sz === size); return s + (v ? v[1] * q : 0); }, 0);

  return (
    <div data-screen-label="Guest link v2" style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <div className="appbar">
        <div className="titles">
          <span className="t">Pod<span style={{ color: "var(--accent, #ff2d87)" }}>pult</span>ovka</span>
          <span className="s">Objednávka cez {G2.host}</span>
        </div>
        <div className="grow"></div>
        {closed ? <span className="chip p2-lock" title="Objednávky sú zatvorené">{I.lock()}</span> : <span className="chip acc">Otvorené</span>}
      </div>
      <BrandStrip tickerText={closed ? "+++ OBJEDNÁVKY ZATVORENÉ +++ ĎALŠIA OBJEDNÁVKA O 4 TÝŽDNE +++" : "+++ SPOLOČNÁ OBJEDNÁVKA +++ BEZ REGISTRÁCIE +++"} />

      <div style={{ padding: pad, paddingBottom: 8, maxWidth: 760, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        {closed ? (
          <React.Fragment>
            <div className="card hl" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <span className="badge" style={{ alignSelf: "flex-start" }}>Zatvorené</span>
              <h1 className="h-screen" style={{ fontSize: phone ? 30 : 38, lineHeight: 1.12 }}>Objednávky sú<br /><span className="hl" style={{ display: "inline-block", lineHeight: .95, marginTop: 4 }}>zatvorené</span></h1>
              <div className="sub" style={{ fontSize: 14.5, lineHeight: 1.45 }}><b style={{ color: "var(--ink)" }}>{G2.host}</b> vás pozýva do spoločnej objednávky výberovej kávy. Ďalšia objednávka sa otvorí približne <b style={{ color: "var(--ink)" }}>{G2.next.date}</b> ({G2.next.inWeeks}).</div>
              <G2Roasters />
            </div>

            <div className="card" style={{ padding: 16 }}>
              <div className="field-lbl" style={{ marginBottom: 12 }}>Ako to funguje</div>
              <G2Steps />
            </div>

            {sent ? (
              <div className="banner ok"><span className="dot"></span><div style={{ minWidth: 0 }}><b>Dáme vedieť.</b> Keď sa objednávka otvorí, príde vám správa na WhatsApp s odkazom od {G2.host}.</div></div>
            ) : (
              <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div className="display" style={{ fontSize: 22, lineHeight: 1 }}>Dajte mi vedieť</div>
                  <div className="sub" style={{ marginTop: 4 }}>Pošleme jednu správu, keď sa objednávka otvorí. Nič viac.</div>
                </div>
                <Field label="Meno"><Input placeholder="Meno a priezvisko" /></Field>
                <Field label="Mobil"><Input placeholder="09xx xxx xxx" inputMode="tel" /></Field>
                <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, cursor: "pointer" }}><Checkbox checked={wa} onChange={setWa} /> Súhlasím so správou cez WhatsApp</label>
                <button className="btn accent block" onClick={() => setSent(true)}>Chcem vedieť, keď sa otvorí</button>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginTop: 6 }}>
              <span className="field-lbl">Minulá ponuka · september 2026</span>
              <span className="sub mono" style={{ whiteSpace: "nowrap", fontSize: 12 }}>len na prezretie</span>
            </div>
            <div className="p2-ro" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {window.CatTabs ? <CatTabs cats={D.tabs} cat={cat} setCat={setCat} /> : null}
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {(D.products[cat] || []).slice(0, 2).map((p) => <CoffeeCard key={p.id} p={p} cart={cart} setQty={setQty} disabled phone={phone} />)}
              </div>
            </div>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <div className="card hl" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <h1 className="h-screen" style={{ fontSize: phone ? 28 : 36 }}>{D.cycle.name}</h1>
              <div className="sub" style={{ fontSize: 14 }}>Spoločná objednávka · organizuje <b style={{ color: "var(--ink)" }}>{G2.host}</b> · objednávky do {D.cycle.date}</div>
              <G2Steps compact />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <G2Roasters />
                <button className="btn ghost sm" style={{ color: "var(--accent)", fontWeight: 700, padding: 0 }} onClick={() => setShowHow(!showHow)}>{showHow ? "Skryť" : "Viac o tom, ako to funguje"}</button>
              </div>
              {showHow && <div style={{ borderTop: "2px solid rgba(10,10,10,0.12)", paddingTop: 12 }}><G2Steps /></div>}
            </div>
            {window.CatTabs ? <CatTabs cats={D.tabs} cat={cat} setCat={setCat} /> : null}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {(D.products[cat] || []).map((p) => <CoffeeCard key={p.id} p={p} cart={cart} setQty={setQty} phone={phone} />)}
            </div>
          </React.Fragment>
        )}
      </div>

      {!closed && (
        <div className="cartbar">
          <div className="meta"><span className="sum">{total.toFixed(2)} EUR</span><span className="deadline">Objednávka do: {D.cycle.date}</span></div>
          <div className="actions"><button className="btn accent" disabled={total === 0}>Objednať</button></div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { GLink2, G2Steps });
