# Deploying to a server

## 1. Copy the repository to the server

```bash
git clone git@github.com:Chibbluffy/bymr-leaderboard-trends.git
cd ~/bymr-leaderboard-trends
git pull
cp .env.example .env   # optional — only needed to override a default, e.g. POLL_INTERVAL_SECONDS
```

(Adjust the clone URL if this project ends up under a different GitHub
account/repo name than `Chibbluffy/bymr-leaderboard-trends` — there's no
remote set up for it yet as of this file being written.)

## 2. Install the systemd services

```bash
sudo cp deploy/bymr-leaderboard-poller.service deploy/bymr-leaderboard-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bymr-leaderboard-poller bymr-leaderboard-server
```

Check both actually started:

```bash
sudo systemctl status bymr-leaderboard-poller bymr-leaderboard-server
journalctl -u bymr-leaderboard-poller -f    # watch it poll live; Ctrl-C to stop watching
```

## 3. nginx

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/bymr-leaderboard.chibbluffy.fyi
sudo ln -s /etc/nginx/sites-available/bymr-leaderboard.chibbluffy.fyi /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

To get HTTPS working and create a cert:

```bash
sudo certbot --nginx -d bymr-leaderboard.chibbluffy.fyi
```

(assumes certbot + the nginx plugin are already installed —
`sudo apt install certbot python3-certbot-nginx` if not).

## Updating

```bash
cd ~/bymr-leaderboard-trends && git pull
sudo systemctl restart bymr-leaderboard-poller bymr-leaderboard-server
```

Restarting is always safe — see the main README's "Restarting `poller.py`
doesn't lose or duplicate data" note. `systemctl restart` (rather than
`stop` + `start`) keeps both units enabled the same way `Restart=on-failure`
already does if either process crashes on its own.
