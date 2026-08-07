/* Podpultovka Friends — Prihlásenie + Portál (cykly, kredit, profil) */
const { useState: usePS } = React;

function FLogin({ device, nav }) {
  const phone = device === "phone";
  const [showPw, setShowPw] = usePS(false);
  return (
    <div data-screen-label="Prihlásenie">
      <div className="appbar">
        <div className="titles">
          <span className="t">Pod<span style={{ color: "var(--accent, #ff2d87)" }}>pult</span>ovka</span>
          <span className="s">Členský vstup</span>
        </div>
        <div className="grow"></div>
        <span className="chip acc">Len pre svojich</span>
      </div>
      <BrandStrip tickerText="+++ VSTUP LEN PRE SVOJICH +++ HESLO NEDÁVAJ ĎALEJ +++" />
      <div style={{ padding: phone ? 20 : 32, maxWidth: 480, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ textAlign: "center", marginTop: phone ? 8 : 24 }}>
          <h1 className="h-screen" style={{ fontSize: phone ? 40 : 52 }}>Kto <span className="hl">klope?</span></h1>
          <div className="sub" style={{ marginTop: 12, fontSize: 14 }}>Prihláste sa užívateľským menom a heslom.</div>
        </div>
        <div className="card" style={{ padding: phone ? 18 : 24, display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label="Užívateľské meno">
            <Input type="text" placeholder="napr. lego" autoCapitalize="none" defaultValue="" />
          </Field>
          <Field label="Heslo">
            <div style={{ position: "relative" }}>
              <Input type={showPw ? "text" : "password"} placeholder="Zadajte heslo" style={{ paddingRight: 48 }} />
              <span onClick={() => setShowPw(!showPw)} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", cursor: "pointer", color: showPw ? "var(--accent)" : "var(--ink-dim)", display: "flex" }}>{I.eye()}</span>
            </div>
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 14 }}>
            <Checkbox checked={true} onChange={() => {}} />
            Zapamätať si ma na tomto zariadení
          </label>
          <button className="btn accent block" onClick={() => nav("f-portal")}>Prihlásiť sa</button>
        </div>
        <div className="card dashed" style={{ padding: 14, fontSize: 13.5, color: "var(--ink-dim)", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ display: "flex", marginTop: 1 }}>{I.lock()}</span>
          <span>Nemáte účet? Podpultovka je na pozvánky — požiadajte kamoša, ktorý už objednáva, alebo si objednajte cez jeho odkaz bez účtu.</span>
        </div>
      </div>
    </div>
  );
}

function CycleCard({ c, nav, onShare }) {
  const D = window.FP_DATA;
  const open = c.status === "open";
  const planned = c.status === "planned";
  return (
    <div className={"card" + (open ? " hl" : "")} style={{ padding: 16, cursor: planned ? "default" : "pointer", opacity: planned ? 0.85 : 1 }}
      onClick={() => !planned && nav(c.type === "bakery" ? "f-bakery" : "f-order")}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div className="display" style={{ fontSize: 22, lineHeight: 1 }}>{c.name}</div>
          <div className="mono sub" style={{ fontSize: 12, marginTop: 7, display: "flex", alignItems: "center", gap: 6 }}>{I.cal()} {c.date}</div>
        </div>
        {!planned && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {c.hasOrder ? <span className="display" style={{ fontSize: 18 }}>{c.orderTotal.toFixed(2)} EUR</span> : null}
            <span style={{ color: "var(--accent)", display: "flex" }}>{I.chev()}</span>
          </div>
        )}
      </div>
      {c.plan ? <div className="mono" style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 10, lineHeight: 1.7 }}>{c.plan.map((l, i) => <div key={i}>{l}</div>)}</div> : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        <span className={"badge" + (c.type === "bakery" ? " acc-o" : " solid")}>{c.type === "bakery" ? "Pekáreň" : "Káva"}</span>
        {planned ? <span className="badge muted">Plánovaný</span> : open ? <span className="badge acc">Otvorený</span> : <span className="badge">Uzamknutý</span>}
        {c.hasOrder ? <span className="badge ok">Objednané · {c.orderKilos || c.orderItems}</span> : open ? <span className="badge warn">Neobjednané</span> : null}
      </div>
      {open && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12, borderTop: "2px solid rgba(10,10,10,0.12)", paddingTop: 12 }}>
          <span className="sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {c.guestCount ? <span className="tabbadge">{c.guestCount}</span> : null}
            {c.guestCount ? "kolegovia cez váš odkaz" : "Objednávate aj pre kolegov?"}
          </span>
          <button className="btn sm" onClick={(e) => { e.stopPropagation(); onShare(c); }}>{I.share()} Zdieľať</button>
        </div>
      )}
    </div>
  );
}

function FPortal({ device, nav }) {
  const D = window.FP_DATA;
  const phone = device === "phone";
  const pad = phone ? 16 : 28;
  const [modal, setModal] = usePS(null); // share | profile | subs | invite
  const [showArchive, setShowArchive] = usePS(false);
  const [subs, setSubs] = usePS({ kava: true, pek: true });

  return (
    <div data-screen-label="Portál — cykly">
      <div className="appbar">
        <div className="titles" style={{ cursor: "pointer" }} onClick={() => setModal("profile")}>
          <span className="t">{D.friend.name}</span>
          <span className="s">{D.friend.code}</span>
        </div>
        <span style={{ opacity: 0.75, display: "flex", cursor: "pointer" }} onClick={() => setModal("profile")}>{I.pencil()}</span>
        <div className="grow"></div>
        <span className="chip acc" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => setModal("invite")}>{I.invite()} Pozvať</span>
        <span style={{ opacity: 0.85, display: "flex", cursor: "pointer" }} onClick={() => nav("f-login")}>{I.logout()}</span>
      </div>
      <BrandStrip tickerText="+++ ČLENSKÝ OKRUH +++ PRE TÝCH, ČO VEDIA +++" />

      <div style={{ padding: pad, maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="card" style={{ padding: phone ? 16 : 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div className="field-lbl" style={{ marginBottom: 4 }}>Môj účet</div>
            <span className="neg pill" style={{ fontSize: 16 }}>{D.friend.balance.toFixed(2)} EUR</span>
          </div>
          <button className="btn sm">Transakcie</button>
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 className="h-screen" style={{ fontSize: phone ? 28 : 34 }}>Objednávkové <span className="hl">cykly</span></h2>
            <span style={{ color: "var(--ink-dim)", cursor: "pointer", display: "flex" }} onClick={() => setModal("subs")}>{I.gear()}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {D.portalCycles.map((c) => <CycleCard key={c.id} c={c} nav={nav} onShare={() => setModal("share")} />)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 18, cursor: "pointer", fontWeight: 600, fontSize: 14, color: "var(--ink-dim)" }} onClick={() => setShowArchive(!showArchive)}>
            <span className={"chev" + (showArchive ? " open" : "")}>{I.chev()}</span> Archív ({D.archive.length})
          </div>
          {showArchive && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
              {D.archive.map((c) => (
                <div key={c.id} className="card flat" style={{ padding: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, opacity: 0.85 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                      <span className="badge" style={{ fontSize: 10.5, padding: "2px 7px" }}>{c.type === "bakery" ? "Pekáreň" : "Káva"}</span>
                      <span className="badge muted" style={{ fontSize: 10.5, padding: "2px 7px" }}>Dokončený</span>
                    </div>
                  </div>
                  <span className="mono" style={{ fontSize: 13, flexShrink: 0 }}>{c.orderTotal.toFixed(2)} EUR</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {modal === "share" && <ShareModal onClose={() => setModal(null)} />}
      {modal === "subs" && (
        <Modal title="Nastavenia odberu" onClose={() => setModal(null)}
          footer={<React.Fragment><button className="btn" onClick={() => setModal(null)}>Zrušiť</button><button className="btn accent" onClick={() => setModal(null)}>Uložiť</button></React.Fragment>}>
          <div className="sub">Vyberte, ktoré typy objednávok chcete vidieť:</div>
          {[["kava", "Káva"], ["pek", "Pekáreň"]].map(([k, lbl]) => (
            <label key={k} className="card flat" style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
              <Checkbox checked={subs[k]} onChange={(v) => setSubs({ ...subs, [k]: v })} />
              <span style={{ fontWeight: 700 }}>{lbl}</span>
            </label>
          ))}
          <div className="field-help">Ak nevyberiete nič, zobrazia sa všetky cykly.</div>
        </Modal>
      )}
      {modal === "profile" && <ProfileModal onClose={() => setModal(null)} />}
      {modal === "invite" && (
        <Modal title="Pozvi priateľa" onClose={() => setModal(null)} footer={<button className="btn" onClick={() => setModal(null)}>Zavrieť</button>}>
          <div className="sub">Pošlite tento odkaz priateľovi. Po registrácii ho správca pridá do skupiny.</div>
          <CopyRow value="https://podpultovka.sk/invite/LEGO-9F2K" />
        </Modal>
      )}
    </div>
  );
}

function ProfileModal({ onClose }) {
  const D = window.FP_DATA;
  const [pwOpen, setPwOpen] = usePS(false);
  return (
    <Modal title="Upraviť profil" onClose={onClose}
      footer={<React.Fragment><button className="btn" onClick={onClose}>Zrušiť</button><button className="btn accent" onClick={onClose}>Uložiť</button></React.Fragment>}>
      <div style={{ display: "flex", gap: 10 }}>
        <Field label="Jedinečné ID"><div className="copyrow"><div className="val">{D.friend.code}</div></div></Field>
        <Field label="Užívateľské meno"><div className="copyrow"><div className="val">{D.friend.username}</div></div></Field>
      </div>
      <Field label="Prihlasovacie meno *" help="Toto meno vidí správca a kolegovia.">
        <Input defaultValue={D.friend.name} />
      </Field>
      <Field label="Adresa Packeta výdajného miesta" help="Predvolená adresa pre doručenie Packetou (voliteľné).">
        <Input defaultValue={D.friend.packeta} placeholder="napr. Z-BOX Hlavná 15, Bratislava" />
      </Field>
      <div style={{ borderTop: "2px solid rgba(10,10,10,0.12)", paddingTop: 12 }}>
        <button className="btn ghost sm" onClick={() => setPwOpen(!pwOpen)} style={{ color: "var(--accent)", fontWeight: 700, padding: 0 }}>{pwOpen ? "Skryť zmenu hesla" : "Zmeniť heslo"}</button>
        {pwOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
            <Field label="Aktuálne heslo"><Input type="password" /></Field>
            <Field label="Nové heslo"><Input type="password" /></Field>
            <Field label="Potvrdiť nové heslo"><Input type="password" /></Field>
            <button className="btn sm dark">Zmeniť heslo</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

Object.assign(window, { FLogin, FPortal, CycleCard, ProfileModal });
