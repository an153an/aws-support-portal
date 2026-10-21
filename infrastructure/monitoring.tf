# ---- Alerting: SNS topic (+ optional email subscription) ----
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email # AWS emails a confirmation link that must be clicked
}

# ---- Structured logs -> metric: the app logs one JSON line per event, and 5xx
# responses and unhandled errors are written with level "error". ----
resource "aws_cloudwatch_log_metric_filter" "app_errors" {
  name           = "${var.project_name}-app-errors"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.level = \"error\" }"

  metric_transformation {
    name          = "AppErrors"
    namespace     = "${var.project_name}/App"
    value         = "1"
    default_value = "0"
  }
}

locals {
  alb_dims = {
    LoadBalancer = aws_lb.app.arn_suffix
  }
  tg_dims = {
    LoadBalancer = aws_lb.app.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }
  ecs_dims = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.app.name
  }
  rds_dims = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

# ---- Alarms ----
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.project_name}-alb-5xx"
  alarm_description   = "The load balancer itself returned 5xx responses (e.g. no healthy targets)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = local.alb_dims
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name          = "${var.project_name}-app-5xx"
  alarm_description   = "The app returned 5xx responses to the load balancer"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = local.tg_dims
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${var.project_name}-unhealthy-targets"
  alarm_description   = "One or more Fargate tasks are failing /health checks"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = local.tg_dims
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "slow_responses" {
  alarm_name          = "${var.project_name}-slow-responses"
  alarm_description   = "p95 response time above 2 seconds"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = local.tg_dims
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "app_errors" {
  alarm_name          = "${var.project_name}-app-error-logs"
  alarm_description   = "The app logged several error-level events (from the structured JSON logs)"
  namespace           = "${var.project_name}/App"
  metric_name         = aws_cloudwatch_log_metric_filter.app_errors.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  alarm_name          = "${var.project_name}-ecs-cpu-high"
  alarm_description   = "Service CPU above 85% for 10 minutes (autoscaling is at its ceiling or lagging)"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = local.ecs_dims
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  alarm_name          = "${var.project_name}-ecs-memory-high"
  alarm_description   = "Service memory above 85% for 10 minutes"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = local.ecs_dims
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.project_name}-rds-cpu-high"
  alarm_description   = "Database CPU above 80% for 10 minutes"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = local.rds_dims
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.project_name}-rds-storage-low"
  alarm_description   = "Database free storage below 2 GiB"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = local.rds_dims
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2147483648
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ---- Dashboard ----
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_name}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "alarm", x = 0, y = 0, width = 24, height = 3
        properties = {
          title = "Alarms"
          alarms = [
            aws_cloudwatch_metric_alarm.alb_5xx.arn,
            aws_cloudwatch_metric_alarm.target_5xx.arn,
            aws_cloudwatch_metric_alarm.unhealthy_hosts.arn,
            aws_cloudwatch_metric_alarm.slow_responses.arn,
            aws_cloudwatch_metric_alarm.app_errors.arn,
            aws_cloudwatch_metric_alarm.ecs_cpu.arn,
            aws_cloudwatch_metric_alarm.ecs_memory.arn,
            aws_cloudwatch_metric_alarm.rds_cpu.arn,
            aws_cloudwatch_metric_alarm.rds_storage.arn,
          ]
        }
      },
      {
        type = "metric", x = 0, y = 3, width = 12, height = 6
        properties = {
          title  = "Requests and 5xx errors"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.app.arn_suffix, { label = "Requests" }],
            [".", "HTTPCode_Target_5XX_Count", ".", ".", "TargetGroup", aws_lb_target_group.app.arn_suffix, { label = "App 5xx", color = "#d62728" }],
            [".", "HTTPCode_ELB_5XX_Count", ".", aws_lb.app.arn_suffix, { label = "ALB 5xx", color = "#ff7f0e" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 3, width = 12, height = 6
        properties = {
          title  = "Response time (p50 / p95)"
          region = var.aws_region
          view   = "timeSeries"
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.app.arn_suffix, "TargetGroup", aws_lb_target_group.app.arn_suffix, { stat = "p50", label = "p50" }],
            ["...", { stat = "p95", label = "p95" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 9, width = 8, height = 6
        properties = {
          title  = "Healthy / unhealthy tasks"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Maximum"
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", aws_lb.app.arn_suffix, "TargetGroup", aws_lb_target_group.app.arn_suffix, { label = "Healthy" }],
            [".", "UnHealthyHostCount", ".", ".", ".", ".", { label = "Unhealthy", color = "#d62728" }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 9, width = 8, height = 6
        properties = {
          title  = "ECS service CPU / memory"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Average"
          period = 60
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.app.name, { label = "CPU %" }],
            [".", "MemoryUtilization", ".", ".", ".", ".", { label = "Memory %" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 9, width = 8, height = 6
        properties = {
          title  = "RDS CPU and connections"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Average"
          period = 60
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier, { label = "CPU %" }],
            [".", "DatabaseConnections", ".", ".", { label = "Connections", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 15, width = 12, height = 6
        properties = {
          title   = "App error-level log events"
          region  = var.aws_region
          view    = "timeSeries"
          stat    = "Sum"
          period  = 60
          metrics = [["${var.project_name}/App", "AppErrors", { label = "Errors" }]]
        }
      },
      {
        type = "metric", x = 12, y = 15, width = 12, height = 6
        properties = {
          title   = "RDS free storage (bytes)"
          region  = var.aws_region
          view    = "timeSeries"
          stat    = "Minimum"
          period  = 300
          metrics = [["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", aws_db_instance.main.identifier]]
        }
      },
      {
        type = "log", x = 0, y = 21, width = 24, height = 7
        properties = {
          title  = "Recent errors and slow requests (Logs Insights)"
          region = var.aws_region
          view   = "table"
          query  = "SOURCE '${aws_cloudwatch_log_group.app.name}' | fields @timestamp, level, msg, method, path, status, duration_ms, error | filter level = 'error' or duration_ms > 1000 | sort @timestamp desc | limit 30"
        }
      },
    ]
  })
}
