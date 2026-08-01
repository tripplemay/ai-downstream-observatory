# -*- coding: utf-8 -*-
"""邮件告警：信号灯变化、信号状态变化（规则引擎/AI 季度分析触发）时推送。

配置 config/alerts.json（已 gitignore，参考 config/alerts.example.json）：
  {"enabled": true, "smtp_host": "...", "smtp_port": 465, "smtp_user": "...",
   "smtp_pass": "...", "from": "...", "to": ["..."]}
配置缺失或 enabled=false 时全部静默跳过。单封邮件汇总一次运行的全部变化。
用法: python worker/notify.py --test  （发一封测试邮件验证配置）"""
import json
import os
import smtplib
import sys
from email.header import Header
from email.mime.text import MIMEText

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALERTS_CONF = os.path.join(BASE_DIR, "config", "alerts.json")


def load_conf():
    try:
        with open(ALERTS_CONF, encoding="utf-8") as f:
            conf = json.load(f)
        if not conf.get("enabled"):
            return None
        return conf
    except Exception:
        return None


def send_email(subject, body):
    """配置就绪时发信；返回 True=已发 / False=跳过。发送失败抛异常由调用方记日志。"""
    conf = load_conf()
    if conf is None:
        return False
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = conf["from"]
    msg["To"] = ", ".join(conf["to"])
    port = conf.get("smtp_port", 465)
    if port == 465:
        smtp = smtplib.SMTP_SSL(conf["smtp_host"], port, timeout=30)
    else:
        smtp = smtplib.SMTP(conf["smtp_host"], port, timeout=30)
        smtp.starttls()
    try:
        smtp.login(conf["smtp_user"], conf["smtp_pass"])
        smtp.sendmail(conf["from"], conf["to"], msg.as_string())
    finally:
        smtp.quit()
    return True


def notify_changes(title, changes):
    """一次运行的变化汇总成一封邮件。changes 为空或无配置则静默。"""
    if not changes:
        return
    body = "%s\n\n%s\n\n—— 投资观测台自动告警" % (title, "\n".join("- " + c for c in changes))
    try:
        if send_email(title, body):
            print("[notify] 已发送告警邮件: %s（%d 条变化）" % (title, len(changes)), flush=True)
    except Exception as ex:
        # 告警失败不影响主流程，只记日志
        print("[notify] 邮件发送失败(跳过): %s: %s" % (type(ex).__name__, ex), flush=True)


if __name__ == "__main__":
    if "--test" in sys.argv:
        if send_email("投资观测台告警测试", "这是一封测试邮件：alerts.json 配置生效。"):
            print("测试邮件已发送")
        else:
            print("config/alerts.json 缺失或 enabled=false，未发送")
            sys.exit(1)
