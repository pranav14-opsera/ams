resource "aws_sns_topic" "kafka_alerts" {
  name              = "${local.identifier}-alerts"
  kms_master_key_id = var.platform_kms_key_arn

  tags = local.common_tags
}

# Consumer lag: MSK exposes per-consumer-group lag via
# "kafka-lag-exporter"-style CloudWatch metrics only when enhanced
# monitoring / the Kafka lag exporter add-on is configured; the two
# alarms below target the EstimatedMaxTimeLag metric (minutes converted
# to seconds via period/threshold math) MSK publishes natively under
# enhanced per-topic-per-partition monitoring, set on this module's cluster.
resource "aws_cloudwatch_metric_alarm" "consumer_lag_30s" {
  for_each = local.core_topics

  alarm_name          = "${local.identifier}-${each.key}-lag-30s"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "EstimatedMaxTimeLag"
  namespace           = "AWS/Kafka"
  period              = 60
  statistic           = "Maximum"
  threshold           = 30
  alarm_description   = "Consumer lag on ${each.key} exceeded 30 seconds (warning)"
  alarm_actions       = [aws_sns_topic.kafka_alerts.arn]
  ok_actions          = [aws_sns_topic.kafka_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    "Cluster Name"   = aws_msk_cluster.main.cluster_name
    "Consumer Group" = each.value.consumer_group
    Topic            = each.key
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "consumer_lag_60s" {
  for_each = local.core_topics

  alarm_name          = "${local.identifier}-${each.key}-lag-60s"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "EstimatedMaxTimeLag"
  namespace           = "AWS/Kafka"
  period              = 60
  statistic           = "Maximum"
  threshold           = 60
  alarm_description   = "Consumer lag on ${each.key} exceeded 60 seconds (critical — breaches the dashboard/audit latency SLA)"
  alarm_actions       = [aws_sns_topic.kafka_alerts.arn]
  ok_actions          = [aws_sns_topic.kafka_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    "Cluster Name"   = aws_msk_cluster.main.cluster_name
    "Consumer Group" = each.value.consumer_group
    Topic            = each.key
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "under_replicated_partitions" {
  alarm_name          = "${local.identifier}-under-replicated-partitions"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "UnderReplicatedPartitions"
  namespace           = "AWS/Kafka"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "One or more partitions are under-replicated — a broker may be down or falling behind"
  alarm_actions       = [aws_sns_topic.kafka_alerts.arn]
  ok_actions          = [aws_sns_topic.kafka_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    "Cluster Name" = aws_msk_cluster.main.cluster_name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "active_controller_count" {
  alarm_name          = "${local.identifier}-active-controller-count"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ActiveControllerCount"
  namespace           = "AWS/Kafka"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Cluster has no active controller (should always be exactly 1) — cluster-wide failure risk"
  alarm_actions       = [aws_sns_topic.kafka_alerts.arn]
  ok_actions          = [aws_sns_topic.kafka_alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    "Cluster Name" = aws_msk_cluster.main.cluster_name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  for_each = local.core_topics

  alarm_name          = "${local.identifier}-${each.key}-dlq-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BytesInPerSec"
  namespace           = "AWS/Kafka"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Messages are landing in the ${each.key}-dlq dead-letter topic — failed events need investigation"
  alarm_actions       = [aws_sns_topic.kafka_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    "Cluster Name" = aws_msk_cluster.main.cluster_name
    Topic          = "${each.key}-dlq"
  }

  tags = local.common_tags
}
