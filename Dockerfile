FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

ENV TZ=Asia/Shanghai

EXPOSE 5051
CMD ["gunicorn", "-b", "0.0.0.0:5051", "--workers", "2", "app:app"]
