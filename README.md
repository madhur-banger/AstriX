
# AstriX – Workspace & Project Management Platform

AstriX is a full-stack project management application inspired by tools like Jira.  
It supports **workspaces, projects, members, roles, and tasks**, with authentication, authorization, and a clean modular backend architecture.

---

## Tech Stack

### Backend
- **Node.js**
- **TypeScript**
- **Express**
- **MongoDB + Mongoose**
- **Passport.js (Auth)**
- **Swagger (API Docs)**
- **JWT-based authentication**
- **Role & permission-based access control**

### Frontend
- **React**
- **TypeScript**
- **Vite**
- **Context API**
- **Custom hooks & HOCs**

---

## Project Structure

```

AstriX/
├── backend/
│   ├── src/
│   │   ├── @types/                # Custom TypeScript types
│   │   ├── config/                # App, DB, HTTP, Passport, Swagger configs
│   │   ├── controllers/           # Request handlers (business logic)
│   │   ├── docs/                  # API / Swagger docs
│   │   ├── enums/                 # Enums (roles, status, etc.)
│   │   ├── middlewares/            # Auth, guards, error handlers
│   │   ├── models/                # Mongoose models
│   │   ├── routes/                # API routes
│   │   ├── seeders/               # DB seed scripts
│   │   ├── services/              # Core business services
│   │   ├── utils/                 # Helpers & utilities
│   │   ├── validation/            # Request validation schemas
│   │   └── index.ts               # App entry point
│   ├── package.json
│   ├── tsconfig.json
│   └── node_modules/
│
├── client/
│   ├── src/
│   │   ├── components/            # Reusable UI components
│   │   ├── context/               # Global state management
│   │   ├── hooks/                 # Custom React hooks
│   │   ├── hoc/                   # Higher Order Components
│   │   ├── layout/                # App layouts
│   │   ├── page/                  # Pages / screens
│   │   ├── routes/                # Route definitions
│   │   ├── lib/                   # Utilities & helpers
│   │   ├── types/                 # TypeScript types
│   │   ├── assets/                # Static assets
│   │   ├── App.tsx
│   │   └── main.tsx
│
└── README.md

```

---

## Core Features

### Authentication & Authorization
- User signup & login
- JWT-based authentication
- Role & permission-based access control
- Workspace-level role management

### Workspaces
- Create and manage multiple workspaces
- Invite members
- Assign roles & permissions

### Projects
- Create projects under workspaces
- Project-level access control
- Metadata support (emoji, description, etc.)

### Tasks
- Create, update, delete tasks
- Assign tasks to members
- Task status & lifecycle handling

---

## Backend Routes

### Auth
```

/api/auth

```

### Users
```

/api/users

```

### Workspaces
```

/api/workspaces

```

### Members
```

/api/members

```

### Projects
```

/api/projects

```

### Tasks
```

/api/tasks

```

---

## Validation Layer

Each domain has its own validation schema:
- `auth.validation.ts`
- `workspace.validation.ts`
- `project.validation.ts`
- `task.validation.ts`

Ensures:
- Clean request payloads
- Early error detection
- Consistent API behavior

---

## Configuration

Backend configs are centralized in:

```

backend/src/config/

````

Includes:
- App configuration
- Database connection
- HTTP server setup
- Passport strategies
- Swagger documentation

---

## Environment Variables

Create a `.env` file in `backend/`:


PORT=5000
MONGO_URI=mongodb://localhost:27017/astrix
JWT_SECRET=your_secret_key
NODE_ENV=development


---

## Running the Project

### Backend

cd backend
npm install
npm run dev


### Frontend


cd client
npm install
npm run dev


---

## API Documentation

Swagger is available at:


http://localhost:5000/api/docs


---

## Future Enhancements

* Redis caching
* Event-driven architecture (Kafka)
* Microservices (Go for chat/notifications)
* PostgreSQL migration
* CI/CD with GitHub Actions
* AWS deployment with Terraform

---

## License

This project is for educational and personal development purposes.

---

## Author

Built by **Madhur**
Focused on clean architecture, scalability, and real-world system design.


