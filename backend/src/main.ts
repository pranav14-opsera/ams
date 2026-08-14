import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { PhiMaskingLogger } from "./phi-scrubber/phi-masking.middleware";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Replaces Nest's own logger globally — every framework-internal and
  // application log call goes through PHI scrubbing, not just ones a
  // developer remembers to route through it explicitly (WO-017).
  app.useLogger(app.get(PhiMaskingLogger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
}

bootstrap();
