"""chromosomix in a notebook: the viewer as a Jupyter widget.

>>> from chromosomix import Chromosomix
>>> view = Chromosomix('sample.mcool::/resolutions/5000', region='chr2:10000000-14000000', tracks=['ATAC.bw'])
>>> view                          # the map, its tracks, the side panels — the app, in the cell
>>> view.goto('chr2:12000000-12500000')
>>> view.state['region']          # where the reader has taken it since

See https://chromosomix.app/ and the repository's widgets/python/README.md.
"""

from .server import serve
from .viewer import SITE, install_viewer, installed_viewers, resolve_viewer
from .widget import Chromosomix, address

__all__ = ['Chromosomix', 'SITE', 'address', 'install_viewer', 'installed_viewers', 'resolve_viewer', 'serve']
__version__ = '0.16.0'
