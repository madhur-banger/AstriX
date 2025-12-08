import swaggerJSDoc from "swagger-jsdoc";

import { authSchemas } from "../docs/schemas/auth.schemas";



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
        url: "http://localhost:8000/api",
        description: "Local server",
      },
    ],

    components: {
      schemas: {
        ...authSchemas,
      },
    },
  },

  apis: ["./src/routes/**/*.ts"],
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
