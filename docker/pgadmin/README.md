# pgAdmin Access

## Browser pgAdmin via Docker

1. Run `pnpm db:pgadmin`
2. Open `http://127.0.0.1:5050`
3. Sign in with:
   - Email: `admin@example.com`
   - Password: `admin123`

The PostgreSQL server is pre-registered as `Legal Chatbot PostgreSQL`.

## Desktop pgAdmin App

Import [servers.desktop.json](./servers.desktop.json) or create a server manually with:

- Host: `127.0.0.1`
- Port: `5433`
- Database: `legal_chatbot`
- Username: `postgres`
- Password: `postgres`
