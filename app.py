import requests
import json

WEB_BASE_URL = "https://dev-admin-fota-demo-in.onrender.com"
DEVICE_ID = 11
META_DATA_FILE = "fota_meta_data.json"


def read_fota_details_from_web_server():
    response = requests.get(f"{WEB_BASE_URL}/{DEVICE_ID}/get-fota-details")

    if response.status_code == 200:
        fota_details = response["fotaDetails"]
        meta_data = {
            "id": fota_details["id"],
            "device_id": fota_details["deviceId"],
            "device_old_version": fota_details["deviceOldVersion"],
            "device_new_version": fota_details["deviceNewVersion"],
            "web_old_version": fota_details["webOldVersion"],
            "web_new_version": fota_details["webNewVersion"],
            "status": fota_details["status"],
            "web_status": fota_details["web_status"],
            "device_version_url": fota_details["deviceFotaUrl"],
            "web_version_url": fota_details["webFotaUrl"]
            }

        with open(META_DATA_FILE, "w", encoding="utf-8") as file:
            json.dump(meta_data, file, indent=4)

        print(f"Metadata written to {META_DATA_FILE}")
        
    return None


