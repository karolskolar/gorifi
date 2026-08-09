/* Podpultovka Friends — shell: control bar, router, device frames */
const { useState: useAS, useEffect: useAE, useRef: useAR } = React;

const ROUTES = {
  "f-login": { group: "Priateľ", label: "Prihlásenie", Comp: (p) => <FLogin {...p} /> },
  "f-portal": { group: "Priateľ", label: "Portál — cykly", Comp: (p) => <FPortal {...p} /> },
  "f-order": { group: "Priateľ", label: "Objednávka — moja", Comp: (p) => <FOrder {...p} /> },
  "f-guests": { group: "Priateľ", label: "Objednávka — kolegovia", Comp: (p) => <FOrder {...p} startTab="guests" /> },
  "f-guests-empty": { group: "Priateľ", label: "Kolegovia — prázdny stav", Comp: (p) => <FOrder {...p} startTab="guests" emptyGuests /> },
  "f-order-locked": { group: "Priateľ", label: "Objednávka — uzamknutá", Comp: (p) => <FOrder {...p} locked /> },
  "f-bakery": { group: "Priateľ", label: "Objednávka — pekáreň", Comp: (p) => <FOrder {...p} bakery /> },
  "g-order": { group: "Kolega (bez účtu)", label: "Guest — objednávka", Comp: (p) => <GOrder {...p} /> },
  "g-confirm": { group: "Kolega (bez účtu)", label: "Guest — potvrdenie", Comp: (p) => <GConfirm {...p} /> },
  "g-status": { group: "Kolega (bez účtu)", label: "Guest — stav objednávky", Comp: (p) => <GStatus {...p} />,
    states: [["editable", "Upraviteľná"], ["paid", "Zaplatená"], ["locked", "Uzamknutá"], ["cancelled", "Zrušená"]] },
  "g-dead": { group: "Kolega (bez účtu)", label: "Guest — mŕtvy odkaz", Comp: (p) => <GDead {...p} />,
    states: [["notfound", "Neexistuje"], ["inactive", "Deaktivovaný"], ["closed", "Uzavretý cyklus"]] },
};
const URLS = {
  "f-login": "podpultovka.sk/", "f-portal": "podpultovka.sk/", "f-order": "podpultovka.sk/cycle/42",
  "f-guests": "podpultovka.sk/cycle/42", "f-guests-empty": "podpultovka.sk/cycle/42",
  "f-order-locked": "podpultovka.sk/cycle/41", "f-bakery": "podpultovka.sk/cycle/43",
  "g-order": "podpultovka.sk/g/49GYGVKX", "g-confirm": "podpultovka.sk/g/49GYGVKX",
  "g-status": "podpultovka.sk/g/49GYGVKX/o/M3QLZT7A", "g-dead": "podpultovka.sk/g/XXXXXXXX",
};

const LSF = "podpultovka-friends-state";
function loadFState() { try { return JSON.parse(localStorage.getItem(LSF)) || {}; } catch (e) { return {}; } }

function FriendsApp() {
  const init = loadFState();
  const [device, setDevice] = useAS(init.device || "phone");
  const [route, setRoute] = useAS(ROUTES[init.route] ? init.route : "f-order");
  const [subStates, setSubStates] = useAS(init.subStates || {});
  const layerRef = useAR(null);
  const [, force] = useAS(0);

  useAE(() => { localStorage.setItem(LSF, JSON.stringify({ device, route, subStates })); }, [device, route, subStates]);
  useAE(() => { force((n) => n + 1); }, [device]); // re-render so portal layer ref is fresh after frame swap

  const r = ROUTES[route];
  const subState = r.states ? (subStates[route] || r.states[0][0]) : undefined;
  const phone = device === "phone";
  const screen = (
    <div className="app" key={route + "-" + (subState || "") + "-" + device}>
      {r.Comp({ device, nav: setRoute, subState })}
    </div>
  );

  const groups = {};
  Object.entries(ROUTES).forEach(([k, v]) => { (groups[v.group] = groups[v.group] || []).push([k, v]); });

  return (
    <ModalLayerCtx.Provider value={layerRef}>
      <div id="controls">
        <span className="brandtag">POD<b>PULT</b>OVKA</span>
        <span className="hint">friends portal · 09 neobrutal pp</span>
        <div className="spacer"></div>
        <span className="lbl">Obrazovka</span>
        <select value={route} onChange={(e) => setRoute(e.target.value)}>
          {Object.entries(groups).map(([g, items]) => (
            <optgroup key={g} label={g}>
              {items.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </optgroup>
          ))}
        </select>
        {r.states && (
          <React.Fragment>
            <span className="lbl">Stav</span>
            <select value={subState} onChange={(e) => setSubStates({ ...subStates, [route]: e.target.value })}>
              {r.states.map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
            </select>
          </React.Fragment>
        )}
        <span className="lbl">Zariadenie</span>
        <div className="seg">
          <button className={phone ? "on" : ""} onClick={() => setDevice("phone")}>Telefón</button>
          <button className={!phone ? "on" : ""} onClick={() => setDevice("desktop")}>Desktop</button>
        </div>
      </div>

      <div id="stage">
        <div className="frame-wrap">
          <div className="frame-cap">{r.group} · {r.label}{subState ? " · " + r.states.find(([k]) => k === subState)[1] : ""} · {phone ? "Telefón 378px" : "Desktop 1180px"}</div>
          {phone ? (
            <div className="phone-bezel">
              <div className="phone-screen">
                <div className="phone-notch"></div>
                <div className="screen-scroll">{screen}</div>
                <div className="modal-layer" ref={layerRef}></div>
              </div>
            </div>
          ) : (
            <div className="browser">
              <div className="browser-bar">
                <span className="dot" style={{ background: "#ff5f57" }}></span>
                <span className="dot" style={{ background: "#febc2e" }}></span>
                <span className="dot" style={{ background: "#28c840" }}></span>
                <span className="u">{URLS[route]}</span>
              </div>
              <div className="viewport">
                <div className="screen-scroll">{screen}</div>
                <div className="modal-layer" ref={layerRef}></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalLayerCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<FriendsApp />);
