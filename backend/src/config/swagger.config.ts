import swaggerJSDoc from "swagger-jsdoc";

export const swaggerOptions: swaggerJSDoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Astrix : Project Management App",
      version: "1.0.0",
      description: "Authentication APIs including Google OAuth",
    },
    servers: [
      {
        url: "http://localhost:8000/api",
        description: "Local server",
      },
    ],
  },
  apis: ["./src/routes/**/*.ts"], // route files for annotations
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
