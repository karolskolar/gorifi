/* Podpultovka Friends — data (grounded in gorifi repo + live screenshots) */
window.FP_DATA = (function () {
  const friend = { name: "Lego", code: "X42KPGZZ", username: "lego", balance: -74.24, packeta: "Z-BOX Hlavná 15, Bratislava" };

  const cycle = {
    id: "aug26", name: "Goriffee August 2026", type: "coffee", status: "open",
    date: "29. august 2026",
    plan: ["22. – 28. august — Objednávanie", "1. – 3. september — Delivery"],
    parcelEnabled: true, parcelFee: 3.80,
  };

  // coffee products by category — guest/member prices (markup applied server-side)
  const products = {
    "Espresso": [
      { id: "p1", name: "Brazil Morada da Prata Natural", roast: "Medium roast", roaster: "Goriffee", spec: "100% natural bourbon arabica", notes: "slivka, para orech, karamel", img: "brazil-green", variants: [["250g", 7.60], ["1kg", 30.00]] },
      { id: "p2", name: "Brazil, Caramelo - Natural", roast: "Medium & Full city roast", roaster: "Goriffee", spec: "100% bourbon arabica", notes: "karamel, mliečna čokoláda, orechy", img: "brazil-yellow", variants: [["250g", 6.41], ["1kg", 25.66]] },
      { id: "p3", name: "Highlander espresso blend", roast: "Full city roast", roaster: "Robo", spec: "100% mixed arabica", notes: "čokoláda, figy, veľmi sladká", img: "highlander", variants: [["250g", 7.63], ["1kg", 30.54]] },
      { id: "p4", name: "Milkyway espresso blend", roast: "Medium roast", roaster: "Goriffee", spec: "100% mixed arabica", notes: "čokoláda, orechy, kondenzované mlieko", img: "milkyway", variants: [["250g", 7.63], ["1kg", 30.54]] },
    ],
    "Filter": [
      { id: "p5", name: "Brazil Rodomunho Natural", roast: "Light roast", roaster: "Goriffee", spec: "100% natural bourbon arabica", notes: "hrozno, med, jahoda", img: "peru-red", variants: [["250g", 8.90], ["1kg", 35.30]] },
      { id: "p6", name: "Burundi Gakenke Washed", roast: "Light roast", roaster: "Goriffee", spec: "100% washed bourbon arabica", notes: "brusnice, čerešne, karamel", img: "ecuador", variants: [["250g", 9.40], ["1kg", 37.60]] },
      { id: "p7", name: "Candy Blast Decaf na filter", roast: "Light roast", roaster: "Goriffee", spec: "100% EA sugarcane arabica", notes: "jablko, škorica, karamel", img: "colombia-red", variants: [["250g", 11.20]] },
      { id: "p8", name: "Peach Please filter blend", roast: "Light roast", roaster: "Robo", spec: "100% mixed arabica", notes: "broskyňa, karamel, tropické", img: "peach", variants: [["250g", 13.33]] },
    ],
    "Filter Special": [
      { id: "p12", name: "Colombia La Cristalina", roast: "Light roast", roaster: "Goriffee", spec: "Natural 64h Castillo · SCA 87.5", notes: "jahoda, tropické, komplexná", img: "gobananas", variants: [["250g", 12.00]] },
      { id: "p13", name: "Colombia La Sirena Pina Colada", roast: "Light roast", roaster: "Goriffee", spec: "Washed · Osmotic Dehydration Castillo · SCA 86.5", notes: "ananás, kokos, maslová", img: "colombia-blue", variants: [["250g", 12.00]] },
      { id: "p14", name: "Colombia Sinaloa Passionfruit", roast: "Light roast", roaster: "Robo", spec: "Honey Co-Fermented Pink Bourbon · SCA 86", notes: "marakuja, med, šťavnatá", img: "jednoducho", variants: [["250g", 15.00]] },
    ],
    "Brew Bags": [
      { id: "p9", name: "Peach Please - Brew Bags 8x12g", roast: "Light roast", roaster: "Goriffee", spec: "100% mixed arabica", notes: "broskyňa, karamel, tropické", img: "peach", variants: [["250g", 11.00]] },
    ],
    "Nespresso": [
      { id: "p10", name: "Brazil Caramelo - Kávové kapsule", roast: "Full city roast", roaster: "Goriffee", spec: "100% bourbon arabica", notes: "karamel, čokoláda, orechy", img: "brazil-yellow", variants: [["20 ks × 5g", 10.00]] },
      { id: "p11", name: "Milkyway - Kávové kapsule", roast: "Full city roast", roaster: "Goriffee", spec: "100% mixed arabica", notes: "čokoláda, orechy, kond. mlieko", img: "milkyway", variants: [["20 ks × 5g", 11.90]] },
    ],
  };
  const tabs = ["Espresso", "Filter", "Filter Special", "Brew Bags", "Nespresso"];

  // stock limit demo (FriendOrder availability bar)
  const availability = { p6: { limitKg: 5, remainingKg: 1.25 } };

  const bakeryCycle = {
    id: "bak0815", name: "Pečenie 15.8. (sobota)", type: "bakery", status: "open",
    date: "13. august 2026", plan: ["Objednávky do štvrtka 21:00", "Odovzdávka v sobotu ráno"],
  };
  const bakery = {
    "Slané": [
      { id: "b1", name: "Šunkovo-syrová bageta", weight: "190 g", composition: "pšeničná múka, šunka 22%, ementál, maslo", variants: [["1 ks", 3.20], ["3 ks", 8.90]] },
      { id: "b2", name: "Bryndzové pirôžky", weight: "6 ks · 300 g", composition: "zemiakové cesto, bryndza, slanina, pažítka", variants: [["6 ks", 4.80]] },
    ],
    "Sladké": [
      { id: "b3", name: "Makový závin", weight: "400 g", composition: "kysnuté cesto, mak 40%, hrozienka, citrónová kôra", variants: [["1 ks", 5.60]] },
      { id: "b4", name: "Škoricové slimáky", weight: "4 ks · 320 g", composition: "kysnuté cesto, škorica, maslo, vanilkový krém", variants: [["4 ks", 4.40], ["8 ks", 8.20]] },
    ],
  };
  const bakeryTabs = ["Slané", "Sladké"];

  // host's own cart (pre-seeded, submitted)
  const ownCart = { p1: { "250g": 1 } }; // 7.60 EUR — matches live screenshot

  // colleagues' sub-orders through the share link
  const subOrders = [
    { id: 101, name: "Juraj L", phone: "0905 012 998", paid: true, delivered: false, status: "submitted", items: [
      ["2× Brazil Morada da Prata Natural — 250g", 15.20],
      ["2× Brazil, Caramelo - Natural — 250g", 12.82],
      ["1× Brazil Rodomunho Natural — 250g", 8.90],
      ["1× Peach Please - Brew Bags — 250g", 11.00],
      ["1× Brazil Caramelo - Kávové kapsule — 20 ks", 10.00],
    ] },
    { id: 102, name: "Miša Kováčová", phone: "0910 447 213", paid: false, delivered: false, status: "submitted", items: [
      ["2× Burundi Gakenke Washed — 250g", 18.80],
      ["1× Candy Blast Decaf na filter — 250g", 11.20],
      ["1× Peach Please filter blend — 250g", 13.33],
    ] },
    { id: 103, name: "Tomáš Brath", phone: "0948 320 551", paid: true, delivered: true, status: "submitted", items: [
      ["1× Brazil Rodomunho Natural — 1kg", 35.30],
      ["2× Milkyway espresso blend — 250g", 15.26],
      ["1× Milkyway - Kávové kapsule — 20 ks", 11.90],
    ] },
    { id: 104, name: "Katka P.", phone: "0911 902 664", paid: false, delivered: false, status: "cancelled", items: [
      ["2× Peach Please filter blend — 250g", 26.66],
    ] },
  ];
  const subTotal = (o) => o.items.reduce((s, [, p]) => s + p, 0);
  const liveSubs = subOrders.filter((o) => o.status !== "cancelled");
  const subTotals = {
    count: liveSubs.length,
    total: liveSubs.reduce((s, o) => s + subTotal(o), 0),
    pendingDelivery: liveSubs.filter((o) => !o.delivered).length,
  };

  const shareLink = "https://podpultovka.sk/g/49GYGVKX";
  const payment = {
    iban: "LT38 3250 0546 5752 0876",
    revolut: "podpultovka",
    reference: (name) => `G8 / ${name} / Goriffee August 2026`,
  };

  // guest demo order (confirmation + status screens)
  const guestOrder = {
    name: "Karol Skolar", phone: "0901 234 567",
    items: [
      ["Brazil Rodomunho Natural (250g) ×1", 8.90],
      ["Burundi Gakenke Washed (250g) ×1", 9.40],
      ["Candy Blast Decaf na filter (250g) ×1", 11.20],
    ],
    total: 29.50,
    statusUrl: "https://podpultovka.sk/g/49GYGVKX/o/M3QLZT7A",
  };

  const pickupLocations = [
    { id: 1, name: "Lego doma", address: "Dúbravka" },
    { id: 2, name: "Neškôlka", address: "Karlova Ves" },
    { id: 3, name: "Kancelária BA", address: "Staré Mesto" },
  ];

  // portal cycle list
  const portalCycles = [
    { ...cycle, hasOrder: true, orderTotal: 7.60, orderKilos: "0.25 kg", ordered: true, shared: true, guestCount: subTotals.count },
    { ...bakeryCycle, hasOrder: false, ordered: false },
    { id: "sep26", name: "Goriffee September 2026", type: "coffee", status: "planned", date: "26. september 2026", plan: ["Plánovaný cyklus — objednávky sa otvoria 19.9."], hasOrder: false },
  ];
  const archive = [
    { id: "jul26", name: "Goriffee Júl 2026", type: "coffee", status: "completed", hasOrder: true, orderTotal: 13.09, orderKilos: "0.25 kg" },
    { id: "jun26", name: "Goriffee Jún 2026", type: "coffee", status: "completed", hasOrder: true, orderTotal: 44.15, orderKilos: "1.25 kg" },
    { id: "bakmaj", name: "Pečenie 5.5. (utorok)", type: "bakery", status: "completed", hasOrder: true, orderTotal: 9.80, orderItems: "3 ks" },
  ];

  const friendNames = ["Anna Frohlich", "Braňo Ulbrík", "Eva Kasuba", "Georgo", "Janči Timoranský", "Katka Hájeková", "Lego", "Luky Hlásny", "Mário Vavrovič"];

  return { friend, cycle, products, tabs, availability, bakeryCycle, bakery, bakeryTabs, ownCart, subOrders, subTotal, subTotals, shareLink, payment, guestOrder, pickupLocations, portalCycles, archive, friendNames };
})();
