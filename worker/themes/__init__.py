# -*- coding: utf-8 -*-
"""主题注册表：新主题加一个同级模块并在此登记。"""
from . import ai_downstream, etf_universe

ALL_THEMES = [ai_downstream.THEME, etf_universe.THEME]
