import swaggerJSDoc from "swagger-jsdoc";

import { config } from "./app.config";
import { authSchemas } from "../docs/schemas/auth.schemas";
import { projectSchemas } from "../docs/schemas/project.schemas";
import { taskSchemas } from "../docs/schemas/task.schemas";
import { userSchemas } from "../docs/schemas/user.schemas";

export const swaggerOptions: swaggerJSDoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Astrix : Project Management App",
      version: "1.0.0",
      description: "Project Management APIs with Auth implemented",
    },
    servers: [
      {
        url: config.API_PUBLIC_URL,
        description: `${config.NODE_ENV} server`,
      },
    ],

    components: {
      schemas: {
        ...authSchemas,
        ...projectSchemas,
        ...taskSchemas,
        ...userSchemas,
      },
    },
  },

  apis: ["./src/routes/**/*.ts"],
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
