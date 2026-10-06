"""Frozen JSON-lines engine entry; teaching code uses the separate bundled Python."""
import sys
from pathlib import Path
entry=Path(__file__).resolve().parent
sys.path.insert(0,str(entry.parent if entry.name=='build' else entry))
from ice_agent.desktop_service import main

if __name__ == '__main__':
    main()
