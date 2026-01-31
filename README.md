# Gorifi - Sprava objednavok kavy

Jednoducha webova aplikacia na spravu skupinovych objednavok kavy.

## Funkcionalita

- **Admin panel**: Sprava cyklov, produktov, priatelov, export sumaru
- **Objednavanie**: Kazdy priatel dostane unikatny odkaz na objednavku
- **Kosik**: Real-time vypocet ceny, ulozenie kosika
- **Distribucia**: Prehlad objednavok podla priatelov pre balenie
- **Platby**: Sledovanie kto zaplatil

## Struktura projektu

```
gorifi/
├── backend/          # Node.js + Express API
│   ├── src/
│   │   ├── db/      # SQLite databaza
│   │   ├── routes/  # API endpointy
│   │   └── index.js
│   └── package.json
│
└── frontend/         # Vue 3 + Vite + Tailwind
    ├── src/
    │   ├── views/   # Stranky
    │   └── api.js   # API klient
    └── package.json
```

## Spustenie pre vyvoj

### Backend

```bash
cd backend
npm install
npm run dev
```

Backend bezi na `http://localhost:3000`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend bezi na `http://localhost:5173`

## Produkcne nasadenie

### Backend (LXC na Proxmox)

1. Skopirovat `backend/` do LXC kontajnera
2. Nainstalovat Node.js 18+
3. Spustit cez PM2 alebo systemd:

```bash
cd /path/to/backend
npm install --production
pm2 start src/index.js --name gorifi
```

4. Nastavit nginx reverse proxy pre HTTPS

### Frontend (GitHub Pages)

1. Nastavit `VITE_API_URL` v `.env.production`:
```
VITE_API_URL=https://vas-backend-server.sk/api
```

2. Buildnut:
```bash
cd frontend
npm run build
```

3. Nahrat obsah `dist/` na GitHub Pages

### Alternativa: Oboje na Proxmox

Servovat frontend z nginx na rovnakom serveri:

```nginx
server {
    listen 443 ssl;
    server_name gorifi.vas-server.sk;

    location / {
        root /var/www/gorifi;
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

## Import produktov z CSV

Podporovane stlpce (velke/male pismena, SK/EN):
- `Name`, `name`, `Nazov`, `nazov`
- `Description1`, `Popis1`
- `Description2`, `Popis2`
- `Roast`, `Prazenie`
- `Purpose`, `Ucel`
- `Price250g`, `Cena250g`, `250g`
- `Price1kg`, `Cena1kg`, `1kg`

Priklad CSV:
```csv
Name,Roast,Purpose,Price250g,Price1kg
Ethiopia Sidamo,Stredne,Filter,8.50,29.00
Brazil Santos,Tmave,Espresso,7.50,25.00
```

## Pouzitie

1. **Prvy start**: Nastavte admin heslo
2. **Novy cyklus**: Vytvorte objednavkovy cyklus (napr. "Januar 2026")
3. **Import produktov**: Nahrajte CSV alebo pridajte manualne
4. **Pridajte priatelov**: Kazdy dostane unikatny odkaz
5. **Zdielanie**: Posielite odkazy priatelom
6. **Uzamknutie**: Ked deadline vyprs, uzamknite objednavky
7. **Export**: Skopirutej sumar pre kaviarenu
8. **Distribucia**: Pouzite prehlad na balenie
9. **Platby**: Oznacte kto zaplatil

## Zaloha dat

SQLite databaza je ulozena v `backend/src/db/database.sqlite`. Staci zalohovat tento subor.

## Reset admin hesla

Admin heslo je ulozene ako SHA-256 hash v databaze. Pre reset spustite prikaz (nahradte `noveheslo` vasim heslom):

### Lokalne (macOS)

```bash
sqlite3 backend/src/db/database.sqlite "UPDATE settings SET value = '$(echo -n 'noveheslo' | shasum -a 256 | cut -d' ' -f1)' WHERE key = 'admin_password';"
```

### Lokalne (Linux)

```bash
sqlite3 backend/src/db/database.sqlite "UPDATE settings SET value = '$(echo -n 'noveheslo' | sha256sum | cut -d' ' -f1)' WHERE key = 'admin_password';"
```

### Staging

```bash
ssh gorifi "sqlite3 /var/www/gorifi-staging/backend/src/db/database.sqlite \"UPDATE settings SET value = '\$(echo -n 'noveheslo' | sha256sum | cut -d' ' -f1)' WHERE key = 'admin_password';\""
```

### Production

```bash
ssh gorifi "sqlite3 /var/www/gorifi/backend/src/db/database.sqlite \"UPDATE settings SET value = '\$(echo -n 'noveheslo' | sha256sum | cut -d' ' -f1)' WHERE key = 'admin_password';\""
```
