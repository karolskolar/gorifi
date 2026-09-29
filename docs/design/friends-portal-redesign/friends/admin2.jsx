/* Podpultovka — Admin prototype (2026-09): Distribúcia board (F8) · WhatsApp správy (F5) · WhatsApp nastavenia.
   Desktop-first (1180); the admin app will be re-skinned later — this prototype borrows the Podpultovka theme
   only to settle LAYOUT and FLOW. */
const { useState: useA2, useMemo: useA2M } = React;

const A2 = (function () {
  const D = window.FP_DATA;
  const locs = D.pickupLocations; // Lego doma · Neškôlka · Kancelária BA
  const bags = [
    { id: 1, name: "Lego", kind: "friend", type: "pickup", target: 2, items: 3, kg: 1.25, total: 52.80, paid: false, packed: true, handed: false,
      guests: [{ id: 101, name: "Juraj L", items: 5, total: 57.92, paid: true, packed: true }, { id: 102, name: "Miša Kováčová", items: 3, total: 43.33, paid: false, packed: false }, { id: 103, name: "Tomáš Brath", items: 3, total: 62.46, paid: true, packed: true }] },
    { id: 2, name: "Anna Frohlich", kind: "friend", type: "pickup", target: 2, items: 2, kg: 0.5, total: 17.30, paid: true, packed: true, handed: true, guests: [] },
    { id: 3, name: "Braňo Ulbrík", kind: "friend", type: "pickup", target: 2, items: 1, kg: 1, total: 30.00, paid: false, packed: false, handed: false, guests: [] },
    { id: 4, name: "Eva Kasuba", kind: "friend", type: "pickup", target: 1, items: 4, kg: 1.5, total: 48.20, paid: true, packed: true, handed: false, guests: [] },
    { id: 5, name: "Georgo", kind: "friend", type: "pickup", target: 1, items: 2, kg: 0.5, total: 15.23, paid: false, packed: false, handed: false, guests: [] },
    { id: 6, name: "Janči Timoranský", kind: "friend", type: "pickup", target: 3, items: 1, kg: 0.25, total: 9.40, paid: true, packed: true, handed: false, guests: [] },
    { id: 7, name: "Katka Hájeková", kind: "friend", type: "packeta", target: "Z-BOX Hlavná 15, Trnava", phone: "0905 111 222", items: 3, kg: 0.75, total: 31.10, paid: true, packed: true, handed: false, guests: [] },
    { id: 8, name: "Luky Hlásny", kind: "friend", type: "packeta", target: "Packeta · Tesco Nitra", phone: "0911 333 444", items: 2, kg: 2, total: 60.54, paid: false, packed: false, handed: false, guests: [] },
    { id: 9, name: "Zuzana K.", kind: "guest", type: "packeta", target: "Z-BOX Kysucká 3, Žilina", phone: "0948 555 666", host: "Lego", items: 1, kg: 0.25, total: 12.00, paid: true, packed: true, handed: true, guests: [] },
    { id: 10, name: "Mário Vavrovič", kind: "friend", type: "in_person", target: null, items: 2, kg: 0.5, total: 16.30, paid: false, packed: true, handed: false, guests: [] },
    { id: 11, name: "Peter S.", kind: "friend", type: "in_person", target: "Poznámka: donesiem do práce", items: 1, kg: 0.25, total: 7.60, paid: true, packed: false, handed: false, guests: [] },
  ];
  const templates = [
    { key: "pickup", name: "Doručené na odberné miesto", text: "Ahoj {meno}, vaša káva z Podpultovky je na odbernom mieste {miesto} ({adresa}). Môžete si ju vyzdvihnúť. Suma na úhradu: {suma}. Ďakujeme!" },
    { key: "packeta", name: "Odovzdané Packete", text: "Ahoj {meno}, váš balík z Podpultovky sme odovzdali Packete na {miesto}. Sledovanie: {tracking}. Suma na úhradu: {suma}." },
    { key: "host", name: "Odovzdané priateľovi", text: "Ahoj {meno}, vašu objednávku z Podpultovky sme odovzdali {host}. Dohodnite si s ním/ňou prevzatie. Suma na úhradu: {suma}." },
    { key: "closing", name: "Objednávky sa čoskoro zatvárajú", text: "Ahoj {meno}, objednávky kávy sa zatvárajú {datum}. Ak chcete, ešte stihnete objednať: {odkaz}" },
    { key: "waitlist", name: "Objednávka otvorená (čakajúci hostia)", text: "Ahoj {meno}, {host} vám otvoril objednávku kávy z Podpultovky. Objednávajte tu: {odkaz}" },
  ];
  return { locs, bags, templates };
})();

const a2eur = (v) => v.toFixed(2) + " EUR";

function A2Appbar({ title, sub, route, nav }) {
  const items = [["a-dist", "Distribúcia"], ["a-wa", "WhatsApp správy"], ["a-wa-settings", "Nastavenia · WhatsApp"]];
  return (
    <React.Fragment>
      <div className="appbar">
        <div className="titles"><span className="t">Pod<span style={{ color: "var(--accent)" }}>pult</span>ovka <span style={{ color: "var(--nav-ink-dim)", fontSize: 16 }}>· admin</span></span><span className="s">{sub}</span></div>
        <div className="grow"></div>
        <div className="a2-nav">{items.map(([k, l]) => <span key={k} className={"tab" + (route === k ? " on" : "")} style={{ background: route === k ? "var(--accent)" : "transparent", color: "#fff", borderColor: route === k ? "var(--nb-ink)" : "rgba(255,255,255,0.35)" }} onClick={() => nav(k)}>{l}</span>)}</div>
      </div>
      <div className="hazard"></div>
    </React.Fragment>
  );
}

/* ---------- Distribúcia ---------- */
function ADist({ device, nav }) {
  const D = window.FP_DATA;
  const [bags, setBags] = useA2(A2.bags);
  const [groupBy, setGroupBy] = useA2("delivery"); // delivery | stage | friend
  const [stage, setStage] = useA2("all"); // all | topack | packed | handed
  const [focus, setFocus] = useA2(null);
  const [confirm, setConfirm] = useA2(null);
  const [toast, setToast] = useA2(null);

  const stageOf = (b) => b.handed ? "handed" : b.packed ? "packed" : "topack";
  const targetName = (b) => b.type === "packeta" ? "Packeta" : b.type === "pickup" ? A2.locs.find((l) => l.id === b.target).name : "Osobne";
  const targetKey = (b) => b.type === "packeta" ? "packeta" : b.type === "pickup" ? "loc" + b.target : "person";

  const groups = useA2M(() => {
    const vis = bags.filter((b) => stage === "all" || stageOf(b) === stage);
    if (groupBy === "friend") return [{ key: "all", title: "Všetci", cls: "", bags: [...vis].sort((a, b) => a.name.localeCompare(b.name)) }];
    if (groupBy === "stage") return [["topack", "Na zabalenie", "person"], ["packed", "Zabalené", ""], ["handed", "Odovzdané", "host"]].map(([k, t, cls]) => ({ key: k, title: t, cls, bags: vis.filter((b) => stageOf(b) === k) }));
    const order = ["packeta", ...A2.locs.map((l) => "loc" + l.id), "person"];
    return order.map((k) => {
      const gb = vis.filter((b) => targetKey(b) === k);
      const loc = k.startsWith("loc") ? A2.locs.find((l) => "loc" + l.id === k) : null;
      return { key: k, title: k === "packeta" ? "Packeta" : k === "person" ? "Osobné odovzdanie" : loc.name, sub: k === "packeta" ? "zásielky odovzdáte na pobočke / Z-BOXe" : k === "person" ? "dohodnete individuálne" : loc.address, cls: k === "packeta" ? "packeta" : k === "person" ? "person" : "", bags: gb };
    }).filter((g) => g.bags.length > 0 || stage === "all");
  }, [bags, groupBy, stage]);

  const plan = ["packeta", ...A2.locs.map((l) => "loc" + l.id), "person"].map((k) => {
    const gb = bags.filter((b) => targetKey(b) === k);
    const loc = k.startsWith("loc") ? A2.locs.find((l) => "loc" + l.id === k) : null;
    return { key: k, title: k === "packeta" ? "Packeta" : k === "person" ? "Osobne" : loc.name, n: gb.length, packed: gb.filter((b) => b.packed).length, handed: gb.filter((b) => b.handed).length, kg: gb.reduce((s, b) => s + b.kg + b.guests.reduce((x, g) => x + 0.25 * g.items, 0), 0) };
  });
  const totals = { n: bags.length, packed: bags.filter((b) => b.packed).length, handed: bags.filter((b) => b.handed).length };

  const setBag = (id, patch) => setBags(bags.map((b) => b.id === id ? { ...b, ...patch } : b));
  const togglePacked = (b) => setBag(b.id, b.packed ? { packed: false, handed: false } : { packed: true });
  const toggleHanded = (b) => { if (!b.packed) return; setBag(b.id, { handed: !b.handed }); };
  const handAll = (g) => {
    const ids = g.bags.filter((b) => b.packed && !b.handed).map((b) => b.id);
    setBags(bags.map((b) => ids.includes(b.id) ? { ...b, handed: true } : b));
    setConfirm(null);
    setToast(`${ids.length} ${ids.length === 1 ? "balíček odovzdaný" : ids.length < 5 ? "balíčky odovzdané" : "balíčkov odovzdaných"} · ${ids.length} správ zaradených na odoslanie (WhatsApp)`);
    setTimeout(() => setToast(null), 3500);
  };

  const Row = ({ b, guest, host }) => {
    const st = guest ? (host.handed ? "handed" : b.packed ? "packed" : "topack") : stageOf(b);
    return (
      <div className={"a2-row" + (guest ? " guest" : "") + (st === "handed" ? " done" : "")}>
        <div className="nm">
          {guest ? <span className="badge acc-o" style={{ fontSize: 10.5, padding: "1px 6px" }}>hosť</span> : b.kind === "guest" ? <span className="badge acc-o" style={{ fontSize: 10.5, padding: "1px 6px" }}>hosť · {b.host}</span> : null}
          <span>{b.name}</span>
          {!guest && b.guests.length > 0 && <span className="badge" style={{ fontSize: 10.5, padding: "1px 6px" }}>+{b.guests.length} hostia</span>}
        </div>
        <div className="dt">
          {guest ? `v balíku hostiteľa · ${b.items} pol.` : b.type === "packeta" ? <span>{b.target} · <span className="mono">{b.phone}</span></span> : b.type === "pickup" ? `${b.items} pol. · ${b.kg} kg` : (b.target || `${b.items} pol. · ${b.kg} kg`)}
        </div>
        <div>{b.paid ? <span className="badge ok" style={{ fontSize: 10.5, padding: "2px 6px" }}>Zaplat.</span> : <span className="badge warn" style={{ fontSize: 10.5, padding: "2px 6px" }}>Nezapl.</span>}</div>
        <label className="st" style={{ cursor: guest ? "default" : "pointer" }}><Checkbox checked={!!b.packed} onChange={() => !guest && togglePacked(b)} /> Zabalené</label>
        <label className="st" style={{ cursor: guest ? "default" : "pointer", opacity: (guest ? host.packed : b.packed) ? 1 : .4 }} title={b.packed ? "" : "Najprv zabaliť"}>
          <Checkbox ok checked={guest ? !!host.handed : !!b.handed} onChange={() => !guest && toggleHanded(b)} /> Odovzdané
        </label>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <A2Appbar route="a-dist" nav={nav} sub={`Distribúcia · ${D.cycle.name} · uzamknuté`} />
      <div className="a2-wrap">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 className="h-screen" style={{ fontSize: 34 }}>Distribúcia <span className="hl">plán</span></h1>
            <div className="sub" style={{ marginTop: 8, fontSize: 14 }}>{totals.n} balíčkov · {totals.packed} zabalených · {totals.handed} odovzdaných</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn">Vytlačiť štítky</button>
            <button className="btn" onClick={() => nav("a-wa")}>Správy ({bags.filter((b) => b.handed).length} vo fronte)</button>
            <button className="btn dark" disabled={totals.handed < totals.n} title={totals.handed < totals.n ? "Až keď je všetko odovzdané" : ""}>Ukončiť objednávku</button>
          </div>
        </div>

        <div className="a2-plan">
          {plan.map((p) => (
            <div key={p.key} className={"pc" + (focus === p.key ? " on" : "")} onClick={() => { setGroupBy("delivery"); setFocus(focus === p.key ? null : p.key); }}>
              <div className="t">{p.key === "packeta" ? I2.truck({ width: 16, height: 16 }) : p.key === "person" ? I2.hand({ width: 16, height: 16 }) : I2.pin({ width: 16, height: 16 })} {p.title}</div>
              <div className="n">{p.n}</div>
              <div className="a2-bar"><i className="h" style={{ width: (p.handed / Math.max(p.n, 1)) * 100 + "%" }}></i><i className="p" style={{ width: ((p.packed - p.handed) / Math.max(p.n, 1)) * 100 + "%" }}></i></div>
              <div className="s">{p.packed}/{p.n} zabal. · {p.handed}/{p.n} odovzd. · {p.kg.toFixed(2)} kg</div>
            </div>
          ))}
        </div>

        <div className="a2-toolbar">
          <div className="tabgroup" style={{ display: "inline-grid" }}>
            {[["delivery", "Podľa doručenia"], ["stage", "Podľa stavu"], ["friend", "Podľa priateľa"]].map(([k, l]) => <span key={k} className={"tab" + (groupBy === k ? " on" : "")} onClick={() => { setGroupBy(k); setFocus(null); }}>{l}</span>)}
          </div>
          <div className="tabs">
            {[["all", "Všetko"], ["topack", "Na zabalenie"], ["packed", "Zabalené"], ["handed", "Odovzdané"]].map(([k, l]) => <span key={k} className={"tab" + (stage === k ? " on" : "")} style={{ minHeight: 36, padding: "6px 12px", fontSize: 13 }} onClick={() => setStage(k)}>{l}</span>)}
          </div>
        </div>

        {toast && <div className="banner ok slim"><span className="dot"></span><span>{toast}</span></div>}

        {groups.filter((g) => !focus || g.key === focus).map((g) => {
          const ready = g.bags.filter((b) => b.packed && !b.handed).length;
          return (
            <div key={g.key} className="a2-group">
              <div className={"a2-gh " + g.cls}>
                <div><div className="gt">{g.title}</div>{g.sub && <div className="gs">{g.sub}</div>}</div>
                <span className="badge solid">{g.bags.length} {g.bags.length === 1 ? "balíček" : g.bags.length < 5 ? "balíčky" : "balíčkov"}</span>
                <span className="gs">{g.bags.filter((b) => b.packed).length} zabal. · {g.bags.filter((b) => b.handed).length} odovzd.</span>
                <div className="acts">
                  <button className="btn sm">Štítky</button>
                  <button className="btn sm" onClick={() => nav("a-wa")}>Správa skupine</button>
                  <button className="btn sm accent" disabled={ready === 0} onClick={() => setConfirm(g)}>Odovzdať zabalené ({ready})</button>
                </div>
              </div>
              {g.bags.length === 0 ? <div className="sub" style={{ padding: "14px 16px" }}>Nič v tejto skupine.</div> : (
                <React.Fragment>
                  <div className="a2-hdr"><span>Kto</span><span>Doručenie / obsah</span><span>Platba</span><span>Krok 1</span><span>Krok 2</span></div>
                  {g.bags.map((b) => (
                    <React.Fragment key={b.id}>
                      <Row b={b} />
                      {b.guests.map((gg) => <Row key={gg.id} b={gg} guest host={b} />)}
                    </React.Fragment>
                  ))}
                </React.Fragment>
              )}
            </div>
          );
        })}
      </div>

      {confirm && (
        <Modal title="Odovzdať zabalené?" subtitle={<span><b style={{ color: "var(--ink)" }}>{confirm.title}</b> · {confirm.bags.filter((b) => b.packed && !b.handed).length} balíčkov prejde do stavu Odovzdané.</span>} onClose={() => setConfirm(null)}
          footer={<React.Fragment><button className="btn" onClick={() => setConfirm(null)}>Zrušiť</button><button className="btn accent" onClick={() => handAll(confirm)}>Áno, odovzdané</button></React.Fragment>}>
          <div className="banner slim"><span className="dot"></span><span>Hostia v balíku hostiteľa sa označia spolu s ním. Peniaze sa nemenia — účtovanie prebehlo pri zabalení.</span></div>
          <div className="sub">Pre každý balíček sa pripraví WhatsApp správa („{confirm.cls === "packeta" ? "Odovzdané Packete" : confirm.cls === "person" ? "Zabalené, dohodneme odovzdanie" : "Doručené na odberné miesto"}“). Odošlete ju jedným tlačidlom v záložke Správy.</div>
        </Modal>
      )}
    </div>
  );
}

/* ---------- WhatsApp správy (composer + outbox) ---------- */
function AWa({ device, nav }) {
  const D = window.FP_DATA;
  const segs = [
    { key: "loc2", name: "Neškôlka — odovzdané dnes", tpl: "pickup", people: [["Lego", "0905 012 998"], ["Anna Frohlich", "0910 447 213"]], vars: { miesto: "Neškôlka", adresa: "Karlova Ves" } },
    { key: "packeta", name: "Packeta — odovzdané dnes", tpl: "packeta", people: [["Katka Hájeková", "0905 111 222"], ["Zuzana K.", "0948 555 666"]], vars: { miesto: "Z-BOX", tracking: "Z 123 4567 890" } },
    { key: "hostguests", name: "Hostia Lega — odovzdané hostiteľovi", tpl: "host", people: [["Juraj L", "0905 012 998"], ["Tomáš Brath", "0948 320 551"]], vars: { host: "Legovi" } },
    { key: "notordered", name: "Neobjednali (otvorená objednávka)", tpl: "closing", people: [["Georgo", "0911 902 664"], ["Braňo Ulbrík", "0902 000 111"], ["Eva Kasuba", "0903 222 333"]], vars: { datum: "v piatok 12. 9.", odkaz: "https://podpultovka.biz/" } },
    { key: "waitlist", name: "Čakajúci hostia (F9)", tpl: "waitlist", people: [["Peter Novák", "0944 123 456"]], vars: { host: "Lego", odkaz: "https://podpultovka.biz/g/49GYGVKX" } },
  ];
  const [segKey, setSegKey] = useA2("loc2");
  const [mode, setMode] = useA2("bot"); // bot | manual
  const seg = segs.find((s) => s.key === segKey);
  const [texts, setTexts] = useA2(() => Object.fromEntries(A2.templates.map((t) => [t.key, t.text])));
  const [sent, setSent] = useA2({});
  const render = (name) => texts[seg.tpl].replace("{meno}", name.split(" ")[0]).replace(/\{(\w+)\}/g, (m, k) => seg.vars[k] || (k === "suma" ? "31,10 €" : m));
  const sendAll = () => { const n = { ...sent }; seg.people.forEach(([nm]) => { n[segKey + nm] = "sent"; }); setSent(n); };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <A2Appbar route="a-wa" nav={nav} sub={`WhatsApp správy · ${window.FP_DATA.cycle.name}`} />
      <div className="a2-wrap">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 className="h-screen" style={{ fontSize: 34 }}>Správy <span className="hl">skupinám</span></h1>
            <div className="sub" style={{ marginTop: 8, fontSize: 14 }}>Správa sa nikdy neodošle sama. Skupinu vyberiete, text skontrolujete, odošlete jedným tlačidlom.</div>
          </div>
          <div className="tabgroup" style={{ display: "inline-grid" }}>
            <span className={"tab" + (mode === "bot" ? " on" : "")} onClick={() => setMode("bot")}>Cez bota (Podpultovka)</span>
            <span className={"tab" + (mode === "manual" ? " on" : "")} onClick={() => setMode("manual")}>Ručne z môjho čísla (wa.me)</span>
          </div>
        </div>

        <div className="a2-side">
          <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="field-lbl">Komu</div>
            {segs.map((s) => (
              <div key={s.key} className={"card flat"} style={{ padding: "10px 12px", cursor: "pointer", borderColor: s.key === segKey ? "var(--nb-ink)" : "rgba(10,10,10,0.25)", background: s.key === segKey ? "var(--accent-soft)" : "#fff", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }} onClick={() => setSegKey(s.key)}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</span><span className="badge">{s.people.length}</span>
              </div>
            ))}
            <div className="field-help">Skupiny vznikajú samy: z odovzdania balíčkov (Distribúcia), z otvorenej objednávky a z čakajúcich hostí.</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div className="field-lbl" style={{ marginBottom: 0 }}>Šablóna · {A2.templates.find((t) => t.key === seg.tpl).name}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{["meno", "miesto", "suma", "host", "odkaz"].map((k) => <span key={k} className="a2-ph">{"{" + k + "}"}</span>)}</div>
              </div>
              <textarea className="a2-ta" value={texts[seg.tpl]} onChange={(e) => setTexts({ ...texts, [seg.tpl]: e.target.value })} />
            </div>

            <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div className="field-lbl" style={{ marginBottom: 0 }}>Náhľad · {seg.people.length} príjemcov</div>
                {mode === "bot"
                  ? <button className="btn accent" onClick={sendAll}>Poslať skupine ({seg.people.length})</button>
                  : <span className="sub">Každý riadok otvorí chat s predvyplneným textom vo vašom WhatsAppe.</span>}
              </div>
              {seg.people.map(([nm, ph]) => {
                const st = sent[segKey + nm];
                return (
                  <div key={nm} className="a2-msg">
                    <div className="who">{nm}<div className="sub mono" style={{ fontSize: 11.5 }}>{ph}</div></div>
                    <div className="txt">{render(nm)}</div>
                    {mode === "bot"
                      ? (st === "sent" ? <span className="badge ok">Odoslané</span> : <span className="badge muted">Vo fronte</span>)
                      : <button className="btn sm" onClick={() => setSent({ ...sent, [segKey + nm]: "sent" })}>{st === "sent" ? "Otvorené ✓" : "Otvoriť chat"}</button>}
                  </div>
                );
              })}
              {mode === "bot" && <div className="field-help">Bot posiela s odstupom 3–10 s, max. 30 správ/hod. Pri chybe prihlásenia sa zastaví a ukáže to tu.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Nastavenia · WhatsApp ---------- */
function AWaSettings({ device, nav }) {
  const [connected, setConnected] = useA2(true);
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <A2Appbar route="a-wa-settings" nav={nav} sub="Nastavenia · WhatsApp bot" />
      <div className="a2-wrap">
        <h1 className="h-screen" style={{ fontSize: 34 }}>WhatsApp <span className="hl">bot</span></h1>
        <div className="a2-side">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className={"card" + (connected ? " hl" : "")} style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div className="display" style={{ fontSize: 22, lineHeight: 1 }}>Stav</div>
                {connected ? <span className="badge ok">Pripojené</span> : <span className="badge danger">Odpojené</span>}
              </div>
              <div style={{ marginTop: 10 }}>
                <div className="a2-kv"><span className="sub">Číslo bota</span><b className="mono">+421 9xx xxx xxx</b></div>
                <div className="a2-kv"><span className="sub">Zariadenie</span><b>WhatsApp Web · server</b></div>
                <div className="a2-kv"><span className="sub">Posledná správa</span><b>dnes 14:32</b></div>
                <div className="a2-kv"><span className="sub">Vo fronte / odoslané / chyby</span><b className="mono">4 / 128 / 0</b></div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="btn sm" onClick={() => setConnected(!connected)}>{connected ? "Odpojiť" : "Pripojiť"}</button>
                <button className="btn sm">Poslať testovaciu správu</button>
              </div>
            </div>
            {!connected && (
              <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "center", textAlign: "center" }}>
                <div className="display" style={{ fontSize: 20, lineHeight: 1 }}>Spárovať telefón</div>
                <div className="sub">Na telefóne s číslom bota: WhatsApp → Prepojené zariadenia → Prepojiť zariadenie → naskenujte.</div>
                <QRBox seed={11} />
                <div className="sub mono" style={{ fontSize: 12 }}>QR sa obnoví o 20 s</div>
              </div>
            )}
            <div className="card flat" style={{ padding: 16 }}>
              <div className="field-lbl">Tempo odosielania</div>
              <div className="a2-kv"><span className="sub">Odstup medzi správami</span><b className="mono">3–10 s</b></div>
              <div className="a2-kv"><span className="sub">Max. za hodinu</span><b className="mono">30</b></div>
              <div className="a2-kv"><span className="sub">Súhlas (opt-in)</span><b>41 z 43 priateľov</b></div>
              <div className="field-help" style={{ marginTop: 8 }}>Správy sa odosielajú len ľuďom so zapnutým súhlasom v profile. Bez platného čísla sa riadok preskočí a označí.</div>
            </div>
          </div>
          <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div className="display" style={{ fontSize: 22, lineHeight: 1 }}>Šablóny</div><span className="sub">3 na štart · 2 pripravené</span></div>
            {A2.templates.map((t, i) => (
              <div key={t.key} className="card flat" style={{ padding: "12px 14px", opacity: i < 3 ? 1 : .6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 14.5 }}>{t.name}</b>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>{i < 3 ? <span className="badge ok">Zapnuté</span> : <span className="badge muted">Neskôr</span>}<button className="btn ghost sm" style={{ color: "var(--accent)", fontWeight: 700 }}>Upraviť</button></div>
                </div>
                <div className="sub" style={{ marginTop: 6, lineHeight: 1.4 }}>{t.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ADist, AWa, AWaSettings, A2Appbar });
