import { Module } from "@nestjs/common";
import { ClassificationRuleEngine } from "./classification-rule-engine";
import { DataClassificationTagger } from "./data-classification-tagger";

@Module({
  providers: [ClassificationRuleEngine, DataClassificationTagger],
  exports: [ClassificationRuleEngine, DataClassificationTagger],
})
export class ClassificationModule {}
