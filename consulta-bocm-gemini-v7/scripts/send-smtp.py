"""Send the daily report through Gmail SMTP using an application password."""
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage


def main():
    payload = json.load(sys.stdin)
    password = os.environ.get("GOOGLE_APP_PASSWORD", "").replace(" ", "")
    if not password:
        raise ValueError("Falta GOOGLE_APP_PASSWORD en GitHub Secrets.")
    message = EmailMessage()
    message["From"] = payload["from"]
    message["To"] = ", ".join(payload["to"])
    message["Subject"] = payload["subject"]
    message.set_content(payload["text"])
    message.add_alternative(payload["html"], subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=ssl.create_default_context()) as smtp:
        smtp.login(payload["from"], password)
        refused = smtp.send_message(message)
        if refused:
            raise smtplib.SMTPException("Google rechazó al menos un destinatario.")
    print("Mensaje aceptado por Gmail SMTP.")


if __name__ == "__main__":
    try:
        main()
    except smtplib.SMTPAuthenticationError:
        sys.exit("Google rechazó la contraseña de aplicación. Comprueba GOOGLE_APP_PASSWORD y BOCM_MAIL_FROM.")
    except (smtplib.SMTPException, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        sys.exit(f"No se pudo enviar por SMTP ({type(exc).__name__}). Revisa el paso de envío y los secretos.")
