# Shared by start.sh and stop.sh. OpenDuet keeps one .env, and OpenBot's scripts in openbot/ read
# openbot/.env and rewrite it in place (they mint tokens into it). So the real file lives at
# openbot/.env and the .env at the repository root is a link to it, which keeps `cp .env.example .env`
# and editing .env at the root working.
link_env() {
  if [ -L .env ]; then
    return 0
  fi
  if [ -f .env ] && [ -e openbot/.env ]; then
    printf '\033[31m%s\033[0m\n' "There is a .env here and another in openbot/. Keep one: move the one you want to openbot/.env and delete the other."
    exit 1
  fi
  if [ -f .env ]; then
    mv .env openbot/.env
  fi
  if [ ! -e openbot/.env ]; then
    printf '\033[31m%s\033[0m\n' ".env is missing. Copy .env.example to .env and fill in the required settings."
    exit 1
  fi
  ln -s openbot/.env .env
}
