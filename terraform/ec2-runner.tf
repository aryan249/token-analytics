# ── Security Group ────────────────────────────────────────────────────────────

resource "aws_security_group" "runner" {
  name_prefix = "${var.project}-runner-"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = var.ssh_port
    to_port     = var.ssh_port
    protocol    = "tcp"
    cidr_blocks = [var.runner_ssh_cidr]
    description = "SSH"
  }

  tags = { Name = "${var.project}-runner-sg" }
}

# ── AMI (latest Amazon Linux 2023) ───────────────────────────────────────────

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ── EC2 Instance ──────────────────────────────────────────────────────────────

resource "aws_instance" "runner" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.runner_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.runner.id]
  iam_instance_profile   = aws_iam_instance_profile.runner.name

  root_block_device {
    volume_size = var.runner_volume_size
    volume_type = "gp3"
  }

  user_data = base64encode(templatefile("${path.module}/runner-init.sh", {
    github_repo   = var.github_repo
    runner_token  = var.github_runner_token
    runner_name   = "${var.project}-runner"
    runner_labels = "self-hosted,linux,x64"
  }))

  # Auto-recover if instance fails hardware check
  monitoring = true # detailed CloudWatch monitoring (1-min intervals)

  tags = { Name = "${var.project}-github-runner" }
}

# ── CloudWatch Alarms — runner health monitoring ─────────────────────────────

# Alert if instance status check fails (hardware/network issue)
resource "aws_cloudwatch_metric_alarm" "runner_status_check" {
  alarm_name          = "${var.project}-runner-status-check"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "GitHub Actions runner instance failed status check"
  dimensions = {
    InstanceId = aws_instance.runner.id
  }
  # Auto-recover the instance on hardware failure
  alarm_actions = ["arn:aws:automate:${var.aws_region}:ec2:recover"]
}

# Alert if CPU is at 0% for 10 minutes (runner agent likely dead)
resource "aws_cloudwatch_metric_alarm" "runner_idle" {
  alarm_name          = "${var.project}-runner-idle"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 10
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  alarm_description   = "Runner CPU near zero for 10min — agent may be dead"
  dimensions = {
    InstanceId = aws_instance.runner.id
  }
}

# Alert if disk usage is high (docker images fill the 30GB volume)
resource "aws_cloudwatch_metric_alarm" "runner_disk" {
  alarm_name          = "${var.project}-runner-disk-full"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "disk_used_percent"
  namespace           = "CWAgent"
  period              = 300
  statistic           = "Average"
  threshold           = var.runner_disk_alert_threshold
  alarm_description   = "Runner disk usage above ${var.runner_disk_alert_threshold}%"
  dimensions = {
    InstanceId = aws_instance.runner.id
    path       = "/"
    fstype     = "xfs"
  }
}
