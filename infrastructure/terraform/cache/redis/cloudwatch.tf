resource "aws_sns_topic" "redis_alerts" {
  name              = "${local.identifier}-alerts"
  kms_master_key_id = var.platform_kms_key_arn

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "memory_high" {
  alarm_name          = "${local.identifier}-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Redis memory usage above 80%"
  alarm_actions       = [aws_sns_topic.redis_alerts.arn]
  ok_actions          = [aws_sns_topic.redis_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.main.id
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${local.identifier}-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "EngineCPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 70
  alarm_description   = "Redis engine CPU above 70%"
  alarm_actions       = [aws_sns_topic.redis_alerts.arn]
  ok_actions          = [aws_sns_topic.redis_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.main.id
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "replication_lag_high" {
  alarm_name          = "${local.identifier}-replication-lag-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ReplicationLag"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 5
  alarm_description   = "Redis replica falling more than 5s behind primary"
  alarm_actions       = [aws_sns_topic.redis_alerts.arn]
  ok_actions          = [aws_sns_topic.redis_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.main.id
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "connections_high" {
  alarm_name          = "${local.identifier}-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CurrConnections"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 1000
  alarm_description   = "Redis connection count above 1000"
  alarm_actions       = [aws_sns_topic.redis_alerts.arn]
  ok_actions          = [aws_sns_topic.redis_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = aws_elasticache_replication_group.main.id
  }

  tags = local.common_tags
}
