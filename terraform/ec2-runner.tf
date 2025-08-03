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
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
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
    volume_size = 30
    volume_type = "gp3"
  }

  user_data = base64encode(templatefile("${path.module}/runner-init.sh", {
    github_repo  = var.github_repo
    runner_token = var.github_runner_token
    runner_name  = "${var.project}-runner"
    runner_labels = "self-hosted,linux,x64"
  }))

  tags = { Name = "${var.project}-github-runner" }
}
