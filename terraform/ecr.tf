resource "aws_ecr_repository" "app" {
  name                 = var.project
  image_tag_mutability = var.ecr_tag_mutability
  force_delete         = false  # protect production images from accidental terraform destroy

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "${var.project}-ecr" }
}

resource "aws_ecr_lifecycle_policy" "cleanup" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        # Keep images that are currently deployed (pulled recently)
        rulePriority = 1
        description  = "Keep last ${var.ecr_keep_images} recently pulled images"
        selection = {
          tagStatus   = "any"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.ecr_retention_days
        }
        action = { type = "expire" }
      }
    ]
  })
}
